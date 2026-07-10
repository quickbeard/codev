import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@/lib/configure.js";
import { logDebug, logWarn } from "@/lib/log.js";

// Tools installed via npm-global. Extension/plugin variants (Claude Code +
// Continue) are not npm packages — VS Code installs them via
// `code --install-extension` (lib/vscode.ts) and JetBrains installs them via
// the per-IDE CLI (lib/jetbrains.ts). Keep them out of these maps so callers
// can't accidentally `npm install -g` something that doesn't exist and the
// type checker enforces routing through the right module.
export type NpmTool = Exclude<
	Tool,
	| "vscode-claude-code"
	| "jetbrains-claude-code"
	| "vscode-continue"
	| "jetbrains-continue"
>;

export function isNpmTool(tool: Tool): tool is NpmTool {
	return (
		tool !== "vscode-claude-code" &&
		tool !== "jetbrains-claude-code" &&
		tool !== "vscode-continue" &&
		tool !== "jetbrains-continue"
	);
}

export const PKG: Record<NpmTool, string> = {
	"claude-code": "@anthropic-ai/claude-code",
	opencode: "opencode-ai",
	"codev-code": "codev-code",
	codex: "@openai/codex",
};

export const CLI: Record<NpmTool, string> = {
	"claude-code": "claude",
	opencode: "opencode",
	"codev-code": "codev",
	codex: "codex",
};

// Dist-tags appended to the install spec at `npm install -g` time. Kept
// separate from PKG because the bare name is reused elsewhere where an `@tag`
// would be wrong: detectInstalledViaNpm builds the npm-root directory path from
// PKG, and the install row label renders PKG verbatim. Claude Code pins
// `stable` (a more conservative channel than npm's default `latest`); a tool
// with no entry installs `latest`.
export const DIST_TAG: Partial<Record<NpmTool, string>> = {
	"claude-code": "stable",
};

// On Windows, `npm` is a `.cmd` shim that `execFile` can't resolve without a
// shell. Enabling the shell on win32 lets the OS find `npm.cmd`/`npx.cmd`.
export const USE_SHELL = process.platform === "win32";

export interface ExecResult {
	stdout: string;
	stderr: string;
	error: NodeJS.ErrnoException | null;
}

export function execAsync(file: string, args: string[]): Promise<ExecResult> {
	// Every child process codev shells out to funnels through here (npm, the
	// agent --version probes, `code --install-extension`, JetBrains CLIs,
	// codegraph), so this one seam gives the diagnostic log full child-process
	// coverage: a start document, then an exit document with duration and — on
	// failure — the exit code and a stderr tail.
	logDebug(`exec: ${file} ${args.join(" ")}`, {
		action: "process.spawn",
		eventType: "start",
		extra: { command: file, args },
	});
	const startedAt = Date.now();
	return new Promise((resolve) => {
		const done = (
			error: NodeJS.ErrnoException | null,
			stdout: string,
			stderr: string,
		) => {
			const durationMs = Date.now() - startedAt;
			if (error) {
				logWarn(`exec failed: ${file} ${args.join(" ")}`, {
					action: "process.exit",
					eventType: "end",
					outcome: "failure",
					durationMs,
					err: error,
					extra: {
						command: file,
						args,
						exit_code: error.code ?? null,
						stderr_tail: (stderr ?? "").slice(-2048),
					},
				});
			} else {
				logDebug(`exec ok: ${file} ${args.join(" ")}`, {
					action: "process.exit",
					eventType: "end",
					outcome: "success",
					durationMs,
					extra: { command: file, args },
				});
			}
			resolve({
				stdout: stdout ?? "",
				stderr: stderr ?? "",
				error,
			});
		};
		// Node 22's DEP0190 deprecates the (file, args, { shell: true })
		// signature: with shell:true the args are concatenated, not escaped,
		// so passing them separately implies an escaping that isn't
		// happening. The fix is to compose the command string ourselves and
		// pass it as the only positional argument. Our args are simple npm
		// flags + package names with no whitespace, so naive concatenation
		// matches what Node was already doing — same semantics, no warning.
		if (USE_SHELL) {
			execFile(
				`${file} ${args.join(" ")}`,
				{ shell: true, encoding: "utf-8" },
				(err, stdout, stderr) =>
					done(err as NodeJS.ErrnoException | null, stdout, stderr),
			);
		} else {
			execFile(file, args, { encoding: "utf-8" }, (err, stdout, stderr) =>
				done(err as NodeJS.ErrnoException | null, stdout, stderr),
			);
		}
	});
}

// The `npm install -g` target for a tool: `<pkg>@<tag>` when a dist-tag is
// pinned, otherwise the bare package name (npm defaults to `latest`).
function installSpec(tool: NpmTool): string {
	const tag = DIST_TAG[tool];
	return tag ? `${PKG[tool]}@${tag}` : PKG[tool];
}

// Flags appended to every global agent install. They counter hostile global
// `.npmrc` settings that would otherwise carry into codev's install and leave
// an agent unrunnable:
//   --include=optional      re-includes the platform-native optionalDependency
//                           a global `omit=optional` would drop. Claude Code
//                           and Codex both ship their native binary this way.
//   --ignore-scripts=false  re-enables lifecycle scripts a global
//                           `ignore-scripts=true` would suppress, so Claude
//                           Code's postinstall (install.cjs) runs and copies
//                           the native binary over its placeholder stub.
// CLI flags win over `.npmrc`. Without these the install "succeeds" but
// `claude` fails at runtime with "claude native binary not installed".
const HARDENING_FLAGS = ["--include=optional", "--ignore-scripts=false"];

export async function installPackage(pkg: string): Promise<string | null> {
	const r = await execAsync("npm", ["i", "-g", pkg, ...HARDENING_FLAGS]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function npmGlobalRoot(): Promise<string | null> {
	const r = await execAsync("npm", ["root", "-g"]);
	if (r.error) return null;
	const root = r.stdout.trim();
	return root || null;
}

export async function verifyInstall(tool: NpmTool): Promise<string | null> {
	const r = await execAsync(CLI[tool], ["--version"]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function runClaudePostinstall(): Promise<string | null> {
	const root = await npmGlobalRoot();
	if (!root) return "could not resolve npm root -g";
	const script = join(root, "@anthropic-ai", "claude-code", "install.cjs");
	if (!existsSync(script)) return `${script} does not exist`;
	const r = await execAsync("node", [script]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

// Claude Code ships a tiny (~4 KB) placeholder at bin/claude.exe and downloads
// the real (hundreds of MB) native binary as a platform-specific
// optionalDependency, which its postinstall copies over the placeholder. When
// the placeholder is still in place, `claude` exits with "claude native binary
// not installed". This is a best-effort runtime probe: it stats the
// npm-global placeholder and reports it missing only when it can positively
// confirm the stub is still there. Anything it can't resolve (npm root fails,
// the file isn't npm-managed) returns false so callers stay quiet rather than
// print a misleading hint. The .exe name is used on every platform (Unix
// ignores the extension) — matching the package's own bin field.
export async function claudeNativeBinaryMissing(): Promise<boolean> {
	const root = await npmGlobalRoot();
	if (!root) return false;
	const bin = join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe");
	try {
		return statSync(bin).size < 4096;
	} catch {
		return false;
	}
}

// Recovery for a Claude Code install whose native binary never got placed (so
// `claude --version` fails). Two root causes, two fixes, cheapest first:
//   1. postinstall was suppressed (ignore-scripts) but the optional dep is on
//      disk — re-running install.cjs copies the binary into place.
//   2. the optional dep was never downloaded (omit=optional) — install.cjs
//      can't help (it exits 0 without placing anything), so we force a full
//      reinstall, which re-fetches the optional dep (installPackage carries
//      --include=optional) and runs the postinstall again.
// Each fix is followed by a re-verify, so a postinstall that exits 0 without
// actually placing the binary still falls through to the reinstall.
async function recoverClaudeNativeBinary(
	firstVerify: string,
): Promise<string | null> {
	const cli = CLI["claude-code"];

	const postErr = await runClaudePostinstall();
	if (!postErr) {
		const afterPost = await verifyInstall("claude-code");
		if (!afterPost) return null;
	}

	const reinstallErr = await installPackage(installSpec("claude-code"));
	if (!reinstallErr) {
		const afterReinstall = await verifyInstall("claude-code");
		if (!afterReinstall) return null;
		return `installed but '${cli}' still fails after recovery (postinstall + reinstall): ${afterReinstall}`;
	}
	return `installed but '${cli}' fails (${firstVerify}); recovery reinstall failed: ${reinstallErr}`;
}

// Codex's npm package resolves its native binary via an `optionalDependencies`
// entry that uses an `npm:` alias against a dist-tagged version of the same
// package (e.g. `@openai/codex-win32-x64@npm:@openai/codex@<v>-win32-x64`).
// On Windows, `npm install -g` has historically failed to resolve that alias
// during global installs, leaving codex with no native binary at runtime
// (openai/codex#11744). The recovery is to install both packages explicitly,
// pinned to the same version.
export async function runCodexWindowsRecovery(): Promise<string | null> {
	const versionResult = await execAsync("npm", ["view", PKG.codex, "version"]);
	if (versionResult.error) {
		return `npm view ${PKG.codex} version failed: ${versionResult.stderr.trim() || versionResult.error.message}`;
	}
	const version = versionResult.stdout.trim();
	if (!version) return `could not determine ${PKG.codex} version`;

	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const platformPkg = `@openai/codex-win32-${arch}@npm:${PKG.codex}@${version}-win32-${arch}`;

	const r = await execAsync("npm", [
		"i",
		"-g",
		`${PKG.codex}@${version}`,
		platformPkg,
	]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function installAndVerify(tool: NpmTool): Promise<string | null> {
	const installErr = await installPackage(installSpec(tool));
	if (installErr) return installErr;

	const firstVerify = await verifyInstall(tool);
	if (!firstVerify) return null;

	// Claude Code's package downloads its native binary in a postinstall.
	// If verification fails, the binary wasn't placed — recover by re-running
	// the postinstall and, if that doesn't help, forcing a reinstall.
	if (tool === "claude-code") {
		return recoverClaudeNativeBinary(firstVerify);
	}

	if (tool === "codex" && process.platform === "win32") {
		const recoveryErr = await runCodexWindowsRecovery();
		if (!recoveryErr) {
			const second = await verifyInstall(tool);
			if (!second) return null;
			return `installed but '${CLI[tool]}' still fails after Windows recovery: ${second}`;
		}
		return `installed but '${CLI[tool]}' fails (${firstVerify}); Windows recovery failed: ${recoveryErr}`;
	}

	return `installed but '${CLI[tool]}' fails: ${firstVerify}`;
}

// Is a globally-installed npm package present under `npm root -g`? The shared
// primitive behind agent detection (detectInstalledViaNpm) and the CodeGraph
// update probe (codegraph.ts#detectCodegraphInstalled) — both ask "is <pkg> in
// the global tree?". A scoped name like `@scope/name` splits into the nested
// `@scope/name` directory.
export async function isPackageInstalledGlobally(
	pkg: string,
): Promise<boolean> {
	const root = await npmGlobalRoot();
	if (!root) return false;
	return existsSync(join(root, ...pkg.split("/")));
}

export function detectInstalledViaNpm(tool: NpmTool): Promise<boolean> {
	return isPackageInstalledGlobally(PKG[tool]);
}
