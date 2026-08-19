import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@/lib/configure.js";
import { logDebug, logWarn } from "@/lib/log.js";
import { stripShimDirFromPath } from "@/lib/shims.js";

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

export interface CommandRecord {
	command: string;
	durationMs: number;
	ok: boolean;
}

/**
 * Opt-in record of every child process this module spawns.
 *
 * `codevhub doctor` turns it on so it can show the user exactly what it ran on
 * their machine — a fair question for a diagnostic tool, and one that should
 * not require reading the source. Off by default: no other command needs it,
 * and an always-on buffer would grow unbounded in the upload daemon.
 *
 * It lives inside `execAsync` rather than wrapping it from doctor.ts because
 * helpers in this module (`npmGlobalRoot`, `verifyInstall`, …) call `execAsync`
 * through their module-local binding, which no external wrapper can intercept.
 */
export const commandLog: { enabled: boolean; entries: CommandRecord[] } = {
	enabled: false,
	entries: [],
};

export function recordCommands(): void {
	commandLog.enabled = true;
	commandLog.entries = [];
}

export function execAsync(
	file: string,
	args: string[],
	// `inheritStdin` hands the child our real stdin instead of a pipe. Only the
	// console-mode probe needs it: it reads the Windows console input mode
	// through its stdin handle, and a piped stdin is not a console.
	//
	// `env` replaces the child's environment wholesale (Node's default is to
	// inherit ours, so callers pass a spread of `process.env`). Only
	// `verifyInstall` needs it, to drop our own PATH shim dir — see there.
	options: {
		inheritStdin?: boolean;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<ExecResult> {
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
			if (commandLog.enabled) {
				commandLog.entries.push({
					command: `${file} ${args.join(" ")}`.trim(),
					durationMs,
					ok: !error,
				});
			}
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
		//
		// Quote the file when it carries spaces: callers may pass a resolved
		// absolute path (`C:\Program Files\...\codev.cmd`), which cmd.exe would
		// otherwise split at the space. Args stay unquoted — see above.
		const shellCommand = `${file.includes(" ") ? `"${file}"` : file} ${args.join(" ")}`;

		if (options.inheritStdin) {
			// execFile has no stdio option (neither its typings nor its docs), so
			// a child that needs the caller's real stdin goes through spawn and
			// collects the streams itself.
			const child = USE_SHELL
				? spawn(shellCommand, {
						stdio: ["inherit", "pipe", "pipe"],
						shell: true,
						...(options.env ? { env: options.env } : {}),
					})
				: spawn(file, args, {
						stdio: ["inherit", "pipe", "pipe"],
						...(options.env ? { env: options.env } : {}),
					});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
			child.once("error", (error) =>
				done(
					error as NodeJS.ErrnoException,
					Buffer.concat(out).toString(),
					Buffer.concat(err).toString(),
				),
			);
			child.once("close", (code) =>
				done(
					code === 0
						? null
						: Object.assign(new Error(`${file} exited with code ${code}`), {
								code: String(code),
							}),
					Buffer.concat(out).toString(),
					Buffer.concat(err).toString(),
				),
			);
			return;
		}

		const envOption = options.env ? { env: options.env } : {};

		if (USE_SHELL) {
			execFile(
				shellCommand,
				{ shell: true, encoding: "utf-8", ...envOption },
				(err, stdout, stderr) =>
					done(err as NodeJS.ErrnoException | null, stdout, stderr),
			);
			return;
		}
		execFile(
			file,
			args,
			{ encoding: "utf-8", ...envOption },
			(err, stdout, stderr) =>
				done(err as NodeJS.ErrnoException | null, stdout, stderr),
		);
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

export async function installPackage(
	pkg: string,
	// Appended after the hardening flags. Recovery paths use it to add
	// `--force`; ordinary installs pass nothing.
	extraFlags: string[] = [],
): Promise<string | null> {
	const r = await execAsync("npm", [
		"i",
		"-g",
		pkg,
		...HARDENING_FLAGS,
		...extraFlags,
	]);
	if (!r.error) return null;
	return r.stderr.trim() || r.error.message;
}

export async function npmGlobalRoot(): Promise<string | null> {
	const r = await execAsync("npm", ["root", "-g"]);
	if (r.error) return null;
	const root = r.stdout.trim();
	return root || null;
}

// Probe the freshly-installed agent by asking it for its version.
//
// The child's PATH has ~/.codev-hub/bin stripped, because that directory holds
// CoDev's own shims: on a machine that has installed before, a bare `codev`
// resolves to `codev.cmd`, which re-execs `codevhub codev --version`, which
// runs `runAgent` — so verification would spawn a whole second hub process and
// prefix the agent's real error with our own "Starting CoDev Code..." banner.
// That banner is exactly what users reported seeing inside the install error.
// `run.ts` strips the same directory for the same reason when it launches an
// agent for real; verification has to match, or it measures the shim rather
// than the binary npm just wrote.
export async function verifyInstall(tool: NpmTool): Promise<string | null> {
	const r = await execAsync(CLI[tool], ["--version"], {
		env: { ...process.env, PATH: stripShimDirFromPath(process.env.PATH) },
	});
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

// CoDev Code's sibling of runClaudePostinstall. `codev-code` ships the same
// shape as Claude Code — a placeholder at bin/codev.exe plus a postinstall that
// copies the real binary out of a platform-specific optionalDependency — so it
// needs the same escape hatch. Running the script directly is the one recovery
// that works no matter what npm decided: npm re-runs install scripts only when
// it considers the tree changed, so a repeat `npm i -g codev-code` over an
// already-current install can report success without ever touching the
// placeholder. `node postinstall.mjs` doesn't ask npm's opinion.
export async function runCodevPostinstall(): Promise<string | null> {
	const root = await npmGlobalRoot();
	if (!root) return "could not resolve npm root -g";
	const script = join(root, PKG["codev-code"], "postinstall.mjs");
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
	return isPlaceholderStub(bin);
}

// CoDev Code's sibling of claudeNativeBinaryMissing, and the probe behind the
// Windows failure this recovery exists for. `codev-code`'s placeholder is a
// 476-byte POSIX shell script that npm nonetheless installs — and links a
// `codev.cmd` shim to — under the name `bin/codev.exe`, because that is the
// package's declared `bin` on every platform. Unix reads the shebang-less text
// as a shell script and prints its "postinstall script was not run" message;
// Windows hands the .exe to the PE loader, which rejects a file that has no PE
// header and reports it through cmd.exe as:
//
//   This version of C:\...\codev-code\bin\codev.exe is not compatible with the
//   version of Windows you're running.
//
// That message names neither npm nor a postinstall, so it reads as "wrong
// architecture" or "unsupported Windows" and sends users chasing their OS
// version. The size probe is what lets us say what actually happened. Same
// conservative default as its Claude sibling: anything we can't resolve is a
// `false`, so a genuinely broken binary is never mislabeled a missing one.
export async function codevNativeBinaryMissing(): Promise<boolean> {
	const root = await npmGlobalRoot();
	if (!root) return false;
	const bin = join(root, PKG["codev-code"], "bin", "codev.exe");
	return isPlaceholderStub(bin);
}

// Both agents ship a placeholder small enough that no real native binary could
// be confused for it (Claude's stub is ~4 KB, CoDev Code's is 476 bytes; the
// binaries they stand in for are 170-250 MB). A file we can't stat is not a
// confirmed stub, so it reports false.
function isPlaceholderStub(path: string): boolean {
	try {
		return statSync(path).size < 4096;
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

// Recovery for a CoDev Code install whose native binary never got placed. Same
// two root causes as Claude Code's, and the same cheapest-first order, with one
// addition that the Claude path doesn't need.
//
// The extra case is npm's own idempotency. `npm i -g codev-code` over a tree npm
// already considers current can finish without re-running install scripts, so
// once bin/codev.exe is left as the placeholder, every subsequent
// `codevhub install` re-reports the same failure and exits 0 from npm — the
// user is stuck in a loop no amount of retrying escapes. Stage 1 sidesteps npm
// entirely by running postinstall.mjs itself, and stage 2's reinstall carries
// `--force` so npm re-fetches and re-links rather than declaring the tree
// already correct.
//
// Reported failures name the placeholder rather than echoing the raw loader
// error, which on Windows blames the OS for something npm did.
async function recoverCodevNativeBinary(
	firstVerify: string,
): Promise<string | null> {
	const cli = CLI["codev-code"];
	// Captured before the repair attempts, which are what change the answer.
	const wasPlaceholder = await codevNativeBinaryMissing();

	const postErr = await runCodevPostinstall();
	if (!postErr) {
		const afterPost = await verifyInstall("codev-code");
		if (!afterPost) return null;
	}

	const reinstallErr = await installPackage(installSpec("codev-code"), [
		"--force",
	]);
	if (!reinstallErr) {
		const afterReinstall = await verifyInstall("codev-code");
		if (!afterReinstall) return null;
		return `installed but '${cli}' still fails after recovery (postinstall + reinstall): ${describeCodevFailure(wasPlaceholder, afterReinstall)}`;
	}
	return `installed but '${cli}' fails (${describeCodevFailure(wasPlaceholder, firstVerify)}); recovery reinstall failed: ${reinstallErr}`;
}

// Replace the platform's own wording with what actually went wrong, when we
// have positively confirmed the placeholder is still in place. Windows' loader
// error ("This version of …\codev.exe is not compatible with the version of
// Windows you're running") is the one users report, and it points at the OS
// rather than at the postinstall that never ran — so a user who follows it
// checks their Windows build and finds nothing wrong. Without that
// confirmation the agent's own message is passed through untouched: a real
// architecture or OS mismatch would produce the same text, and overriding it
// would be the same mistake in reverse.
function describeCodevFailure(wasPlaceholder: boolean, reason: string): string {
	if (!wasPlaceholder) return reason;
	return (
		"CoDev Code's native binary was never unpacked — bin/codev.exe is still " +
		"the placeholder stub, so it isn't a runnable program. This usually means " +
		"npm skipped the package's postinstall script, or the platform-specific " +
		"download (~170 MB) was blocked. Retry on a connection that can reach the " +
		"npm registry, or install it by hand with " +
		`\`npm i -g ${PKG["codev-code"]} --include=optional --ignore-scripts=false --force\`.`
	);
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

	// codev-code ships the same placeholder-plus-postinstall shape, and it is
	// the one agent ToolSelect locks on, so a bare failure here parks the whole
	// wizard on `install-failed` with nothing installed. Recover it too.
	if (tool === "codev-code") {
		return recoverCodevNativeBinary(firstVerify);
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
