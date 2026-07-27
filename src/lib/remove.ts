import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logout } from "@/lib/auth.js";
import { runCodegraphUninstall, unwireCodevCodeMcp } from "@/lib/codegraph.js";
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
	// Live config files left in place because they had no backup *and* don't
	// look CoDev-written — i.e. the user's own configs, which we deliberately
	// preserve. Surfaced so the user knows we didn't touch them; a config CoDev
	// wrote is deleted outright and needs no follow-up.
	keptPaths?: string[];
}

export interface RemoveResult {
	steps: StepResult[];
	anyFailed: boolean;
	// Aggregated across all restore steps — the union of every step's keptPaths.
	keptPaths: string[];
}

// We iterate one Tool per BackupKind. `vscode-continue` and
// `jetbrains-continue` share ~/.continue/config.yaml, so including both
// would restore the file once and then redundantly re-report it (the second
// visit finds no backup left and reports keeping the file the first visit just
// restored). Same for the Claude Code extension variants — they share
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
// restore-or-delete each tool → wipe ~/.codev-hub). Order matters: logout runs
// first because it reads ~/.codev-hub/auth.json to revoke tokens, and the final
// step deletes that dir; unhook runs before the wipe because it cleans rc-file
// sentinel blocks and (on Windows) the user PATH registry entry — state that
// lives OUTSIDE ~/.codev-hub and wouldn't be reached by rmSync(~/.codev-hub). The
// CodeGraph uninstall runs before the config restores so codev's restores are
// the final writer on the files it owns, while CodeGraph still cleans the
// files codev doesn't (e.g. opencode.jsonc); it's best-effort and never fails
// the remove.
export async function runRemove(force = false): Promise<RemoveResult> {
	const steps: StepResult[] = [];

	steps.push(recordStep(await runLogout()));
	steps.push(recordStep(runUnhook()));
	steps.push(recordStep(await runCodegraphRemoval()));
	for (const tool of TOOLS) {
		steps.push(recordStep(runRestoreOrKeep(tool, force)));
	}
	steps.push(recordStep(runWipeCodevDir()));

	return {
		steps,
		anyFailed: steps.some((s) => s.status === "failed"),
		keptPaths: steps.flatMap((s) => s.keptPaths ?? []),
	};
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
// surface a ▲ warning and continue rather than fail the remove. CoDev Code's
// entry gets a direct sweep on top of the CLI uninstall: an older codegraph
// doesn't know the custom target, and the entry may have been written by the
// config shim (see lib/codegraph.ts) — either way `codegraph uninstall` would
// leave it behind. The sweep is a no-op when the entry is already gone,
// including when a custom-target-aware uninstall just removed it.
async function runCodegraphRemoval(): Promise<StepResult> {
	try {
		const err = await runCodegraphUninstall();
		const codevErr = unwireCodevCodeMcp();
		if (!err && !codevErr) {
			return {
				label: "CodeGraph",
				detail: "removed from agents",
				status: "ok",
			};
		}
		if (!err) {
			return {
				label: "CodeGraph",
				detail: `removed from agents; CoDev Code entry left in place: ${codevErr}`,
				status: "warning",
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

function runRestoreOrKeep(tool: Tool, force = false): StepResult {
	const label = TOOL_LABEL[tool];
	try {
		const results = restoreTool(tool, force);
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
				case "deleted":
					return {
						label,
						detail: result.forced
							? `no backup; force-deleted ${result.sourcePath} (not CoDev's)`
							: `no backup; deleted CoDev's ${result.sourcePath}`,
						status: "ok",
					};
				case "kept-live":
					return {
						label,
						detail: `no backup; kept your ${result.sourcePath}`,
						status: "ok",
						keptPaths: [result.sourcePath],
					};
				case "noop":
					return { label, detail: "nothing to restore", status: "noop" };
			}
		}
		let restored = 0;
		let deleted = 0;
		let forced = 0;
		let noop = 0;
		const keptPaths: string[] = [];
		for (const r of results) {
			if (r.status === "restored") restored++;
			else if (r.status === "deleted") {
				deleted++;
				if (r.forced) forced++;
			} else if (r.status === "kept-live") keptPaths.push(r.sourcePath);
			else noop++;
		}
		const kept = keptPaths.length;
		if (restored === 0 && deleted === 0 && kept === 0) {
			return { label, detail: "nothing to restore", status: "noop" };
		}
		const parts: string[] = [];
		if (restored > 0)
			parts.push(`restored ${restored} file${restored === 1 ? "" : "s"}`);
		if (deleted > 0) {
			// Count force-deleted files separately: those weren't CoDev's, so
			// folding them into the plain total would overstate what we owned.
			const suffix = forced > 0 ? `, ${forced} forced` : "";
			parts.push(
				`deleted ${deleted} file${deleted === 1 ? "" : "s"} (no backup${suffix})`,
			);
		}
		if (kept > 0)
			parts.push(`kept ${kept} of your file${kept === 1 ? "" : "s"}`);
		if (noop > 0) parts.push(`${noop} already clean`);
		return { label, detail: parts.join("; "), status: "ok", keptPaths };
	} catch (err) {
		return { label, detail: errorMessage(err), status: "failed" };
	}
}

function runWipeCodevDir(): StepResult {
	const path = join(homedir(), ".codev-hub");
	try {
		if (!existsSync(path)) {
			return {
				label: "~/.codev-hub",
				detail: "already absent",
				status: "noop",
			};
		}
		rmSync(path, { recursive: true, force: true });
		return { label: "~/.codev-hub", detail: `removed ${path}`, status: "ok" };
	} catch (err) {
		return {
			label: "~/.codev-hub",
			detail: errorMessage(err),
			status: "failed",
		};
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
