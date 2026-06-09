import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:os";
import type { Tool } from "@/lib/configure.js";
import { execAsync } from "@/lib/npm.js";

// The npm package that ships the `codegraph` CLI + MCP server.
export const CODEGRAPH_PKG = "@colbymchenry/codegraph";
export const CODEGRAPH_BIN = "codegraph";

// CodeGraph's installer targets that overlap with CoDev's tools. CodeGraph
// also supports cursor/gemini/kiro/etc., but CoDev only installs these three
// CLI agents, so they're the only targets we ever forward.
export type CodegraphTarget = "claude" | "codex" | "opencode";

// TaskList row key for the CodeGraph CLI install that runs in the "Installing
// packages" step. Deliberately not a valid `Tool` so SetupApp can split it out
// of the surviving tool set (it must not flow into Configure / shims) — see
// handleInstallDone.
export const CODEGRAPH_TASK_KEY = "__codegraph__";

// Map a CoDev tool to the CodeGraph `--target` id, or null when CodeGraph has
// no target for it. The two Claude Code *extension* variants map to `claude`
// too: they share ~/.claude config with the CLI, so wiring CodeGraph's MCP
// server there benefits the extension as well. Continue (vscode/jetbrains) has
// no CodeGraph target. Exhaustive over Tool so a new tool is a compile error
// here until it's classified.
export function toolToCodegraphTarget(tool: Tool): CodegraphTarget | null {
	switch (tool) {
		case "claude-code":
		case "vscode-claude-code":
		case "jetbrains-claude-code":
			return "claude";
		case "codex":
			return "codex";
		case "opencode":
			return "opencode";
		case "vscode-continue":
		case "jetbrains-continue":
			return null;
	}
}

// Dedupe-preserving-order list of CodeGraph targets for a tool selection.
// Selecting both `claude-code` and `vscode-claude-code` collapses to a single
// `claude` target.
export function codegraphTargets(tools: Tool[]): CodegraphTarget[] {
	const seen = new Set<CodegraphTarget>();
	const out: CodegraphTarget[] = [];
	for (const tool of tools) {
		const target = toolToCodegraphTarget(tool);
		if (target && !seen.has(target)) {
			seen.add(target);
			out.push(target);
		}
	}
	return out;
}

// Always (re)install the global CodeGraph CLI. CodeGraph's own `install --yes`
// deliberately SKIPS putting itself on PATH, and the MCP configs it writes
// reference the bare `codegraph` command — so CoDev must guarantee the binary
// is resolvable. Returns an error string on failure, or null on success.
export async function ensureCodegraphInstalled(): Promise<string | null> {
	const r = await execAsync("npm", ["i", "-g", CODEGRAPH_PKG]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

// Run CodeGraph's installer for the given targets, user-wide and
// non-interactively. No-op (success) when there are no targets. Returns an
// error string on failure, or null on success.
export async function runCodegraphInstall(
	targets: CodegraphTarget[],
): Promise<string | null> {
	if (targets.length === 0) return null;
	const r = await execAsync(CODEGRAPH_BIN, [
		"install",
		"--target",
		targets.join(","),
		"--location",
		"global",
		"--yes",
	]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

// Run CodeGraph's uninstaller (the inverse of runCodegraphInstall): removes the
// MCP server wiring from every agent, user-wide and non-interactively. Used by
// `codev remove`. Returns an error string on failure — including ENOENT when
// the codegraph package was already removed, which the caller treats as a
// non-fatal warning — or null on success.
export async function runCodegraphUninstall(): Promise<string | null> {
	const r = await execAsync(CODEGRAPH_BIN, [
		"uninstall",
		"--location",
		"global",
		"--yes",
	]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export type CodegraphSetupStatus = "skipped" | "ok" | "warning";

export interface CodegraphSetupResult {
	status: CodegraphSetupStatus;
	targets: CodegraphTarget[];
	// Present only when status === "warning".
	message?: string;
}

// Best-effort CodeGraph MCP wiring for a tool selection. Assumes the CodeGraph
// CLI is already installed — the global `npm i -g` happens earlier (the
// "Installing packages" step in install mode, or right after login in config
// mode), so this only runs `codegraph install` to wire the MCP server into each
// agent. Never throws: any failure (including the binary being absent because
// the earlier install didn't land) folds into a `warning` result so the
// finalize step can surface it without aborting CoDev's own flow. `skipped`
// means the selection had no CodeGraph-eligible tools (e.g. Continue only).
export async function setupCodegraph(
	tools: Tool[],
): Promise<CodegraphSetupResult> {
	const targets = codegraphTargets(tools);
	if (targets.length === 0) return { status: "skipped", targets };

	const configErr = await runCodegraphInstall(targets);
	if (configErr) {
		return {
			status: "warning",
			targets,
			message: `CodeGraph install failed: ${configErr}`,
		};
	}

	return { status: "ok", targets };
}

// Indirection so tests can stub the spawn call without intercepting
// node:child_process at the module level (mirrors `spawner` in lib/run.ts).
export const codegraphRunner = {
	spawn: nodeSpawn,
};

// Transparent passthrough: `codev codegraph <args>` ≡ `codegraph <args>`.
// Inherits stdio so interactive subcommands (the bare installer, prompts)
// work, swallows SIGINT/SIGTERM in the parent so the child handles its own
// cleanup, and prints an install hint on ENOENT. Mirrors lib/run.ts#runAgent,
// minus the shim-dir stripping (CodeGraph isn't shimmed) and upload daemon.
export function forwardToCodegraph(args: string[]): Promise<number> {
	return new Promise((resolve) => {
		// On Windows the npm-installed `codegraph` is a `.cmd` shim that Node's
		// spawn can't resolve without a shell. Use the single-string form to
		// dodge Node 22's DEP0190 (shell:true + args array). Our args come from
		// process.argv; this matches lib/run.ts's win32 handling.
		const child =
			process.platform === "win32"
				? codegraphRunner.spawn(`${CODEGRAPH_BIN} ${args.join(" ")}`, {
						stdio: "inherit",
						shell: true,
					})
				: codegraphRunner.spawn(CODEGRAPH_BIN, args, { stdio: "inherit" });

		const swallow = () => {};
		process.on("SIGINT", swallow);
		process.on("SIGTERM", swallow);
		const cleanup = () => {
			process.off("SIGINT", swallow);
			process.off("SIGTERM", swallow);
		};

		child.once("error", (err: NodeJS.ErrnoException) => {
			cleanup();
			if (err.code === "ENOENT") {
				console.error(
					`'${CODEGRAPH_BIN}' could not be launched. Install it with 'codev install' ` +
						`(select an agent) or 'npm i -g ${CODEGRAPH_PKG}'.`,
				);
			} else {
				console.error(`Failed to run ${CODEGRAPH_BIN}: ${err.message}`);
			}
			resolve(1);
		});

		child.once("exit", (code, signal) => {
			cleanup();
			if (code !== null) {
				resolve(code);
				return;
			}
			const signo = signal ? (constants.signals[signal] ?? 0) : 0;
			resolve(128 + signo);
		});
	});
}
