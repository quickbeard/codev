import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@/lib/configure.js";

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
	codex: "@openai/codex",
};

export const CLI: Record<NpmTool, string> = {
	"claude-code": "claude",
	opencode: "opencode",
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

// The `npm install -g` target for a tool: `<pkg>@<tag>` when a dist-tag is
// pinned, otherwise the bare package name (npm defaults to `latest`).
export function installSpec(tool: NpmTool): string {
	const tag = DIST_TAG[tool];
	return tag ? `${PKG[tool]}@${tag}` : PKG[tool];
}

// On Windows, `npm` is a `.cmd` shim that `execFile` can't resolve without a
// shell. Enabling the shell on win32 lets the OS find `npm.cmd`/`npx.cmd`.
export const USE_SHELL = process.platform === "win32";

export interface ExecResult {
	stdout: string;
	stderr: string;
	error: NodeJS.ErrnoException | null;
}

export function execAsync(file: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		const done = (
			error: NodeJS.ErrnoException | null,
			stdout: string,
			stderr: string,
		) => {
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

export async function installPackage(pkg: string): Promise<string | null> {
	// `--include=optional` defends against a global `--omit=optional` config
	// that would skip Claude Code's platform-native binary.
	// `--foreground-scripts` makes the postinstall log visible if it fails.
	// Both are per-invocation flags; nothing on disk outside the package's
	// own install location is touched.
	const r = await execAsync("npm", [
		"install",
		"-g",
		pkg,
		"--include=optional",
		"--foreground-scripts",
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
		"install",
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
	// If verification fails, the most common cause is that the postinstall
	// was suppressed (e.g. a global --ignore-scripts). Re-run install.cjs
	// directly — it only writes inside the package's own install directory.
	if (tool === "claude-code") {
		const postErr = await runClaudePostinstall();
		if (!postErr) {
			const second = await verifyInstall(tool);
			if (!second) return null;
			return `installed but '${CLI[tool]}' still fails after postinstall: ${second}`;
		}
		return `installed but '${CLI[tool]}' fails (${firstVerify}); postinstall recovery failed: ${postErr}`;
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

export async function detectInstalledViaNpm(tool: NpmTool): Promise<boolean> {
	const root = await npmGlobalRoot();
	if (!root) return false;
	const pkgDir = join(root, ...PKG[tool].split("/"));
	return existsSync(pkgDir);
}
