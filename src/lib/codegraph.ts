import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import {
	codevCodeConfigPath,
	OPENCODE_SCHEMA_URL,
	type Tool,
} from "@/lib/configure.js";
import { logError, logInfo, logWarn } from "@/lib/log.js";
import { execAsync, isPackageInstalledGlobally } from "@/lib/npm.js";
import { formatToolList } from "@/lib/text.js";

// The npm package that ships the `codegraph` CLI + MCP server.
export const CODEGRAPH_PKG = "@colbymchenry/codegraph";
export const CODEGRAPH_BIN = "codegraph";

// CodeGraph's installer targets that overlap with CoDev's tools. CodeGraph
// also supports cursor/gemini/kiro/etc., but CoDev only installs these three
// CLI agents, so they're the only built-in targets we ever forward. `codev` is
// not a built-in: it's the custom target CoDev registers itself (see
// CODEV_TARGET_SPEC) on codegraph versions that support `targets add`, and it
// only ever enters an install CSV through setupCodegraph's capability probe.
export type CodegraphTarget = "claude" | "codex" | "opencode" | "codev";

// TaskList row key for the CodeGraph install that runs in the "Installing
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
		// The codegraph CLI has no *built-in* target for the codev-code fork (its
		// `opencode` target writes ~/.config/opencode/opencode.json, not the
		// fork's ~/.config/codev/codev.json). Deliberately null here: whether the
		// fork can be wired through codegraph depends on the installed binary
		// (custom-target support, upstream PR #1459), which a static map can't
		// know. setupCodegraph special-cases codev-code at runtime instead.
		case "codev-code":
			return null;
		case "vscode-continue":
		case "jetbrains-continue":
			return null;
	}
}

// Does this selection need the CodeGraph npm package at all? True when any
// tool maps to a built-in target, or when CoDev Code is selected — its wiring
// (custom target or config shim, see setupCodegraph) references the global
// `codegraph` binary either way. This — not `codegraphTargets(...).length` —
// is the predicate for the Install row, config mode's CodeGraph step, and the
// finalize frame; gating on targets alone would leave a codev-code-only
// selection with an MCP entry pointing at a binary that was never installed.
export function codegraphEligible(tools: Tool[]): boolean {
	return codegraphTargets(tools).length > 0 || tools.includes("codev-code");
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

// Human-readable agent names for the CodeGraph `--target` ids (which are the
// bare CLI ids — `claude`/`codex`/`opencode`). Used in user-facing messages so
// we show "Claude Code" / "Codex" / "OpenCode" rather than the raw ids.
const CODEGRAPH_TARGET_LABEL: Record<CodegraphTarget, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	codev: "CoDev Code",
};

// Format a list of CodeGraph targets as a natural-English sentence fragment
// with display names and Oxford-comma / "and" joining (e.g. "Codex and
// OpenCode", "Claude Code, Codex, and OpenCode"). Preserves the given order.
export function formatCodegraphTargets(targets: CodegraphTarget[]): string {
	return formatToolList(targets.map((t) => CODEGRAPH_TARGET_LABEL[t]));
}

// Always (re)install the global CodeGraph. CodeGraph's own `install --yes`
// deliberately SKIPS putting itself on PATH, and the MCP configs it writes
// reference the bare `codegraph` command — so CoDev must guarantee the binary
// is resolvable. Returns an error string on failure, or null on success.
export async function ensureCodegraphInstalled(): Promise<string | null> {
	const r = await execAsync("npm", ["i", "-g", CODEGRAPH_PKG]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

// Is the global CodeGraph package present under `npm root -g`? This is the
// signal `codevhub update` uses to decide whether to refresh CodeGraph: update
// only upgrades what's already on disk (the same "detect, then update"
// contract the agent rows follow), so it never freshly installs CodeGraph.
// Install/config gate on the selected tools instead — there's no tool
// selection at update time.
export function detectCodegraphInstalled(): Promise<boolean> {
	return isPackageInstalledGlobally(CODEGRAPH_PKG);
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
// `codevhub remove`. Returns an error string on failure — including ENOENT when
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

// --- CoDev Code wiring -------------------------------------------------------
//
// codegraph has no built-in target for the codev-code fork. Upstream PR #1459
// adds user-defined custom targets (`codegraph targets add <spec>`), with the
// fork as its motivating example. Until that ships everywhere, CoDev wires the
// fork itself. Two paths, chosen per run by probing the installed binary:
//
//   Path A (custom target): register CODEV_TARGET_SPEC via `targets add`, then
//     include `codev` in the one `codegraph install` CSV.
//   Path B (config shim): write the `mcp.codegraph` entry into
//     ~/.config/codev/codev.json(c) directly.
//
// Both paths produce byte-identical config — the same entry, in the same file
// (codevCodeConfigPath) — so a machine can flip between them run-to-run (e.g.
// the day an npm-installed codegraph gains custom-target support) with the
// other path seeing the entry as already correct. Once the released codegraph
// floor supports custom targets, Path B and the probe can simply be deleted.

export const CODEV_TARGET_ID = "codev";

// The spec `codegraph targets add` validates and persists (~/.codegraph/
// targets.json). Field-for-field the `codev` example in PR #1459's design doc:
// the `opencode` family derives every path from appName (~/.config/codev/
// codev.jsonc-or-.json), matching where the fork actually reads.
export const CODEV_TARGET_SPEC = JSON.stringify({
	id: CODEV_TARGET_ID,
	displayName: "CoDev Code",
	family: "opencode",
	appName: "codev",
	schemaUrl: OPENCODE_SCHEMA_URL,
});

// The MCP server entry CoDev Code needs — identical to what codegraph's
// opencode family writes, which is what makes Path A and Path B
// interchangeable on disk. `command` is argv-style (the OpenCode-family
// shape): binary and args in one array, no separate `args` key.
const CODEV_MCP_ENTRY = {
	type: "local",
	command: [CODEGRAPH_BIN, "serve", "--mcp"],
	enabled: true,
};

// Does the installed codegraph support user-defined custom targets? Probed on
// every setup rather than version-compared: codev-hub npm-installs the latest
// codegraph right before wiring, so the capability appears the moment upstream
// releases it — no codev-hub change, no pinning. `targets list` is read-only;
// an older binary rejects the unknown command and we fall back to the shim.
export async function supportsCustomTargets(): Promise<boolean> {
	const r = await execAsync(CODEGRAPH_BIN, ["targets", "list"]);
	return !r.error;
}

// Register (idempotent upsert) the CoDev Code custom target. Returns an error
// string on failure, or null on success.
export async function registerCodevTarget(): Promise<string | null> {
	const r = await execAsync(CODEGRAPH_BIN, [
		"targets",
		"add",
		CODEV_TARGET_SPEC,
	]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

// jsonc-parser options shared by the shim writer and unwirer. Surgical
// modify/applyEdits editing — never a whole-file rewrite — so the user's
// comments, formatting, and sibling MCP servers survive, mirroring both
// codegraph's own installer and lib/vscode-settings.ts.
const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2 } as const;
const JSONC_PARSE_OPTIONS = {
	allowTrailingComma: true,
	allowEmptyContent: true,
} as const;

interface JsoncFile {
	text: string;
	// undefined for an empty/comments-only file; null/primitives are errors.
	root: Record<string, unknown> | undefined;
}

// Parse a JSONC config we intend to edit. Returns an error string when the
// content can't be edited safely (syntax errors, non-object root) — the shim
// never risks corrupting a file it doesn't fully understand.
function readJsoncObject(path: string, text: string): JsoncFile | string {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(text, errors, JSONC_PARSE_OPTIONS);
	if (errors.length > 0) return `${path} has JSON syntax errors`;
	if (
		parsed !== undefined &&
		(typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
	) {
		return `${path} root is not a JSON object`;
	}
	return { text, root: parsed as Record<string, unknown> | undefined };
}

function mcpEntryOf(root: Record<string, unknown> | undefined): unknown {
	const mcp = root?.mcp;
	if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return undefined;
	return (mcp as Record<string, unknown>).codegraph;
}

// Path B: wire the CodeGraph MCP server into CoDev Code's global config by
// editing the file directly. Idempotent: an already-correct entry writes
// nothing, so a config Path A (or the user) wrote is left byte-identical.
// Returns an error string on failure, or null on success.
export function wireCodevCodeMcp(): string | null {
	try {
		const path = codevCodeConfigPath();
		let text = existsSync(path) ? readFileSync(path, "utf-8") : "";
		// Greenfield (or empty file): seed the $schema stub the fork itself
		// writes on first run, then let modify() insert the entry below.
		if (text.trim() === "") {
			text = `${JSON.stringify({ $schema: OPENCODE_SCHEMA_URL }, null, 2)}\n`;
		}
		const file = readJsoncObject(path, text);
		if (typeof file === "string") return file;

		if (
			JSON.stringify(mcpEntryOf(file.root)) === JSON.stringify(CODEV_MCP_ENTRY)
		) {
			return null;
		}
		const edited = applyEdits(
			text,
			modify(text, ["mcp", "codegraph"], CODEV_MCP_ENTRY, {
				formattingOptions: JSONC_FORMATTING,
			}),
		);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, edited);
		logInfo("wired CodeGraph MCP entry into CoDev Code config", {
			action: "configure.write",
			extra: { path },
		});
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

// Inverse of wireCodevCodeMcp, used by `codevhub remove`. No-op when the file
// or entry is absent — including when a custom-target-aware `codegraph
// uninstall` already swept it. Drops an emptied `mcp` wrapper, mirroring
// codegraph's own uninstall. Returns an error string on failure, or null.
export function unwireCodevCodeMcp(): string | null {
	try {
		const path = codevCodeConfigPath();
		if (!existsSync(path)) return null;
		const file = readJsoncObject(path, readFileSync(path, "utf-8"));
		if (typeof file === "string") return file;
		if (mcpEntryOf(file.root) === undefined) return null;

		let edited = applyEdits(
			file.text,
			modify(file.text, ["mcp", "codegraph"], undefined, {
				formattingOptions: JSONC_FORMATTING,
			}),
		);
		const after = readJsoncObject(path, edited);
		if (
			typeof after !== "string" &&
			after.root?.mcp &&
			typeof after.root.mcp === "object" &&
			Object.keys(after.root.mcp).length === 0
		) {
			edited = applyEdits(
				edited,
				modify(edited, ["mcp"], undefined, {
					formattingOptions: JSONC_FORMATTING,
				}),
			);
		}
		writeFileSync(path, edited);
		logInfo("removed CodeGraph MCP entry from CoDev Code config", {
			action: "configure.write",
			extra: { path },
		});
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

export type CodegraphSetupStatus = "skipped" | "ok" | "warning";

export interface CodegraphSetupResult {
	status: CodegraphSetupStatus;
	targets: CodegraphTarget[];
	// Present only when status === "warning".
	message?: string;
}

// Best-effort CodeGraph MCP wiring for a tool selection. Assumes CodeGraph is
// already installed — the global `npm i -g` happens earlier (the
// "Installing packages" step in install mode, or right after login in config
// mode), so this only wires the MCP server into each agent: built-in targets
// via one `codegraph install`, CoDev Code via the custom target when the
// binary supports it (Path A) or the config shim otherwise (Path B). Never
// throws: any failure (including the binary being absent because the earlier
// install didn't land) folds into a `warning` result so the finalize step can
// surface it without aborting CoDev's own flow. `skipped` means the selection
// had no CodeGraph-eligible tools (e.g. Continue only). The returned `targets`
// list is what the success message names, so `codev` joins it on either path.
export async function setupCodegraph(
	tools: Tool[],
): Promise<CodegraphSetupResult> {
	const targets = codegraphTargets(tools);
	const wantsCodevCode = tools.includes("codev-code");
	if (targets.length === 0 && !wantsCodevCode) {
		return { status: "skipped", targets };
	}

	const problems: string[] = [];
	let shimNeeded = wantsCodevCode;

	if (wantsCodevCode && (await supportsCustomTargets())) {
		const regErr = await registerCodevTarget();
		if (regErr) {
			// Not fatal: the shim writes the same entry to the same file, so fall
			// back rather than surface a warning for a path the user never chose.
			logWarn(`codegraph targets add failed; falling back to shim: ${regErr}`, {
				action: "task.result",
				outcome: "failure",
			});
		} else {
			targets.push(CODEV_TARGET_ID);
			shimNeeded = false;
		}
	}

	const installErr = await runCodegraphInstall(targets);
	if (installErr) problems.push(`CodeGraph install failed: ${installErr}`);

	if (shimNeeded) {
		const shimErr = wireCodevCodeMcp();
		if (shimErr) {
			problems.push(`CoDev Code MCP wiring failed: ${shimErr}`);
		} else {
			targets.push(CODEV_TARGET_ID);
		}
	}

	if (problems.length > 0) {
		return { status: "warning", targets, message: problems.join("; ") };
	}
	return { status: "ok", targets };
}

// Indirection so tests can stub the spawn call without intercepting
// node:child_process at the module level (mirrors `spawner` in lib/run.ts).
export const codegraphRunner = {
	spawn: nodeSpawn,
};

// Transparent passthrough: `codevhub codegraph <args>` ≡ `codegraph <args>`.
// Inherits stdio so interactive subcommands (the bare installer, prompts)
// work, swallows SIGINT/SIGTERM in the parent so the child handles its own
// cleanup, and prints an install hint on ENOENT. Mirrors lib/run.ts#runAgent,
// minus the shim-dir stripping (CodeGraph isn't shimmed) and upload daemon.
export function forwardToCodegraph(args: string[]): Promise<number> {
	return new Promise((resolve) => {
		logInfo(`launching ${CODEGRAPH_BIN}`, {
			action: "process.spawn",
			eventType: "start",
			extra: { command: CODEGRAPH_BIN, args },
		});
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
			logError(`failed to launch ${CODEGRAPH_BIN}`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				err,
				extra: { command: CODEGRAPH_BIN, code: err.code ?? null },
			});
			if (err.code === "ENOENT") {
				console.error(
					`'${CODEGRAPH_BIN}' could not be launched. Install it with 'codevhub install' ` +
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
				(code === 0 ? logInfo : logWarn)(
					`${CODEGRAPH_BIN} exited (code ${code})`,
					{
						action: "process.exit",
						eventType: "end",
						outcome: code === 0 ? "success" : "failure",
						extra: { command: CODEGRAPH_BIN, exit_code: code },
					},
				);
				resolve(code);
				return;
			}
			const signo = signal ? (constants.signals[signal] ?? 0) : 0;
			logWarn(`${CODEGRAPH_BIN} exited (signal ${signal})`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				extra: { command: CODEGRAPH_BIN, exit_code: 128 + signo, signal },
			});
			resolve(128 + signo);
		});
	});
}
