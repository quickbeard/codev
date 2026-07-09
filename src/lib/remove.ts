import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logout } from "@/lib/auth.js";
import { runCodegraphUninstall } from "@/lib/codegraph.js";
import { restoreTool, type Tool } from "@/lib/configure.js";
import { logError, logInfo, logWarn } from "@/lib/log.js";
import { uninstallShims } from "@/lib/shims.js";

// "warning" is non-fatal: it surfaces a ▲ note to the user but does NOT count
// toward `anyFailed`, so the overall remove still reports success. Used for the
// best-effort CodeGraph uninstall — if the codegraph package was already
// removed, the command errors, and we warn-and-continue rather than fail.
export type StepStatus = "ok" | "noop" | "warning" | "failed";

export interface StepResult {
	label: string;
	detail: string;
	status: StepStatus;
}

export interface RemoveResult {
	steps: StepResult[];
	anyFailed: boolean;
}

// We iterate one Tool per BackupKind. `vscode-continue` and
// `jetbrains-continue` share ~/.continue/config.yaml, so including both
// would have the second iteration delete the file the first iteration just
// restored. Same for the Claude Code extension variants — they share
// ~/.claude/settings.json with `claude-code`. Use `claude-code` and
// `vscode-continue` as the canonical Tools for each shared kind.
const TOOLS: Tool[] = [
	"claude-code",
	"codex",
	"opencode",
	"codev-code",
	"vscode-continue",
];

// Tools that share a backup file get an editor-neutral label. The non-
// canonical entries (extension variants) are present for type
// exhaustiveness; they aren't reached by the loop above.
const TOOL_LABEL: Record<Tool, string> = {
	"claude-code": "Claude Code config",
	codex: "Codex config",
	opencode: "OpenCode config",
	"codev-code": "CoDev Code config",
	"vscode-claude-code": "Claude Code config",
	"jetbrains-claude-code": "Claude Code config",
	"vscode-continue": "Continue config",
	"jetbrains-continue": "Continue config",
};

// Composes the reversal steps (logout → unhook → codegraph uninstall →
// restore-or-delete each tool → wipe ~/.codev). Order matters: logout runs
// first because it reads ~/.codev/auth.json to revoke tokens, and the final
// step deletes that dir; unhook runs before the wipe because it cleans rc-file
// sentinel blocks and (on Windows) the user PATH registry entry — state that
// lives OUTSIDE ~/.codev and wouldn't be reached by rmSync(~/.codev). The
// CodeGraph uninstall runs before the config restores so codev's restores are
// the final writer on the files it owns, while CodeGraph still cleans the
// files codev doesn't (e.g. opencode.jsonc); it's best-effort and never fails
// the remove.
export async function runRemove(): Promise<RemoveResult> {
	const steps: StepResult[] = [];

	steps.push(recordStep(await runLogout()));
	steps.push(recordStep(runUnhook()));
	steps.push(recordStep(await runCodegraphRemoval()));
	for (const tool of TOOLS) {
		steps.push(recordStep(runRestoreOrDelete(tool)));
	}
	steps.push(recordStep(runWipeCodevDir()));

	return { steps, anyFailed: steps.some((s) => s.status === "failed") };
}

// Diagnostic-log mirror of each step's TUI row, leveled by status.
function recordStep(step: StepResult): StepResult {
	const message = `remove step ${step.label}: ${step.status} — ${step.detail}`;
	const fields = {
		action: "task.result",
		outcome:
			step.status === "failed" ? ("failure" as const) : ("success" as const),
		extra: { label: step.label, detail: step.detail, status: step.status },
	};
	if (step.status === "failed") logError(message, fields);
	else if (step.status === "warning") logWarn(message, fields);
	else logInfo(message, fields);
	return step;
}

// Best-effort: revert CodeGraph's MCP wiring across all agents. If the
// codegraph package was already removed, the command errors (e.g. ENOENT) — we
// surface a ▲ warning and continue rather than fail the remove.
async function runCodegraphRemoval(): Promise<StepResult> {
	try {
		const err = await runCodegraphUninstall();
		if (!err) {
			return {
				label: "CodeGraph",
				detail: "removed from agents",
				status: "ok",
			};
		}
		return {
			label: "CodeGraph",
			detail: `CodeGraph not available — skipped: ${err}`,
			status: "warning",
		};
	} catch (err) {
		// Defensive: runCodegraphUninstall resolves rather than throws, but keep
		// the remove resilient to anything unexpected.
		return {
			label: "CodeGraph",
			detail: `skipped: ${errorMessage(err)}`,
			status: "warning",
		};
	}
}

async function runLogout(): Promise<StepResult> {
	try {
		const ok = await logout();
		return ok
			? { label: "SSO", detail: "signed out", status: "ok" }
			: { label: "SSO", detail: "not signed in", status: "noop" };
	} catch (err) {
		return { label: "SSO", detail: errorMessage(err), status: "failed" };
	}
}

function runUnhook(): StepResult {
	try {
		const r = uninstallShims();
		const removed = r.shimsRemoved.length;
		const patched =
			r.rcFilesUpdated.length + (r.windowsUserPathUpdated ? 1 : 0);
		if (removed === 0 && patched === 0) {
			return { label: "Shims", detail: "none installed", status: "noop" };
		}
		const parts: string[] = [];
		if (removed > 0)
			parts.push(`removed ${removed} shim${removed === 1 ? "" : "s"}`);
		if (r.rcFilesUpdated.length > 0) {
			parts.push(
				`cleaned ${r.rcFilesUpdated.length} rc file${r.rcFilesUpdated.length === 1 ? "" : "s"}`,
			);
		}
		if (r.windowsUserPathUpdated) parts.push("updated user PATH");
		return { label: "Shims", detail: parts.join("; "), status: "ok" };
	} catch (err) {
		return { label: "Shims", detail: errorMessage(err), status: "failed" };
	}
}

function runRestoreOrDelete(tool: Tool): StepResult {
	const label = TOOL_LABEL[tool];
	try {
		const results = restoreTool(tool);
		// Single-file tools surface their per-file message verbatim. Claude
		// returns three results; we roll them up into one counts-based detail
		// since the per-file noise would otherwise overwhelm the remove view.
		if (results.length === 1) {
			const result = results[0];
			if (!result) {
				return { label, detail: "nothing to restore", status: "noop" };
			}
			switch (result.status) {
				case "restored":
					return {
						label,
						detail: `restored from ${result.backupPath}`,
						status: "ok",
					};
				case "deleted-live":
					return {
						label,
						detail: `no backup; deleted ${result.sourcePath}`,
						status: "ok",
					};
				case "noop":
					return { label, detail: "nothing to restore", status: "noop" };
			}
		}
		let restored = 0;
		let deleted = 0;
		let noop = 0;
		for (const r of results) {
			if (r.status === "restored") restored++;
			else if (r.status === "deleted-live") deleted++;
			else noop++;
		}
		if (restored === 0 && deleted === 0) {
			return { label, detail: "nothing to restore", status: "noop" };
		}
		const parts: string[] = [];
		if (restored > 0)
			parts.push(`restored ${restored} file${restored === 1 ? "" : "s"}`);
		if (deleted > 0)
			parts.push(
				`deleted ${deleted} file${deleted === 1 ? "" : "s"} (no backup)`,
			);
		if (noop > 0) parts.push(`${noop} already clean`);
		return { label, detail: parts.join("; "), status: "ok" };
	} catch (err) {
		return { label, detail: errorMessage(err), status: "failed" };
	}
}

function runWipeCodevDir(): StepResult {
	const path = join(homedir(), ".codev");
	try {
		if (!existsSync(path)) {
			return { label: "~/.codev", detail: "already absent", status: "noop" };
		}
		rmSync(path, { recursive: true, force: true });
		return { label: "~/.codev", detail: `removed ${path}`, status: "ok" };
	} catch (err) {
		return { label: "~/.codev", detail: errorMessage(err), status: "failed" };
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
