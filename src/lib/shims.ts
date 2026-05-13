import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const SHIM_AGENTS = ["claude", "opencode", "codex"] as const;
export type ShimAgent = (typeof SHIM_AGENTS)[number];

const SENTINEL_START = "# >>> codev shims (managed) >>>";
const SENTINEL_END = "# <<< codev shims (managed) <<<";

export function shimDir(): string {
	return join(homedir(), ".codev", "bin");
}

// run.ts uses this to strip our shim dir from the child's PATH so that
// `codev claude` -> spawn("claude") resolves the real npm-installed binary
// instead of recursing through the shim.
export function stripShimDirFromPath(
	path: string | undefined,
	sep = delimiter,
): string {
	if (!path) return "";
	const dir = shimDir();
	return path
		.split(sep)
		.filter((p) => p !== dir)
		.join(sep);
}

export interface ShimResult {
	shimDir: string;
	shimsWritten: ShimAgent[];
	rcFilesUpdated: string[];
	windowsUserPathUpdated: boolean;
}

function posixShimContent(agent: ShimAgent): string {
	// Strip our shim dir from PATH *inside the shim* so that whichever `codev`
	// resolves it (including older versions that don't filter their own shim
	// dir) won't loop back through this script when it spawns the real agent.
	return `#!/bin/sh
# This shim is managed by codev. Manual edits will be overwritten.
SHIM_DIR="$HOME/.codev/bin"
new_path=""
old_ifs="$IFS"
IFS=:
set -f
for p in $PATH; do
	if [ "$p" != "$SHIM_DIR" ]; then
		new_path="\${new_path:+$new_path:}$p"
	fi
done
set +f
IFS="$old_ifs"
PATH="$new_path"
export PATH
printf "note: forwarded to 'codev %s'. Run 'codev %s' directly to silence this.\\n" "${agent}" "${agent}" >&2
exec codev ${agent} "$@"
`;
}

function cmdShimContent(agent: ShimAgent): string {
	// Same recursion guard as the POSIX shim: strip our shim dir from PATH so
	// older codev versions that don't filter their own shim dir don't loop.
	return `@echo off\r
REM This shim is managed by codev. Manual edits will be overwritten.\r
setlocal EnableDelayedExpansion\r
set "SHIM_DIR=%USERPROFILE%\\.codev\\bin"\r
set "NEWPATH="\r
for %%P in ("%PATH:;=";"%") do (\r
\tif /I not "%%~P"=="%SHIM_DIR%" (\r
\t\tif defined NEWPATH (set "NEWPATH=!NEWPATH!;%%~P") else (set "NEWPATH=%%~P")\r
\t)\r
)\r
endlocal & set "PATH=%NEWPATH%"\r
echo note: forwarded to 'codev ${agent}'. Run 'codev ${agent}' directly to silence this. 1>&2\r
codev ${agent} %*\r
`;
}

function writeShimFiles(): ShimAgent[] {
	const dir = shimDir();
	mkdirSync(dir, { recursive: true });
	const written: ShimAgent[] = [];
	for (const agent of SHIM_AGENTS) {
		if (process.platform === "win32") {
			writeFileSync(join(dir, `${agent}.cmd`), cmdShimContent(agent));
		} else {
			const path = join(dir, agent);
			writeFileSync(path, posixShimContent(agent));
			chmodSync(path, 0o755);
		}
		written.push(agent);
	}
	return written;
}

// Replaces an existing sentinel block, or appends one if not present.
function applySentinelBlock(existing: string, snippet: string): string {
	const blockRe = new RegExp(
		`${escapeRegExp(SENTINEL_START)}[\\s\\S]*?${escapeRegExp(SENTINEL_END)}\\n?`,
	);
	const block = `${SENTINEL_START}\n${snippet}${SENTINEL_END}\n`;
	if (blockRe.test(existing)) {
		// Use a function replacement so `$&`/`$1` in the snippet are not
		// interpreted as backreferences by String.replace.
		return existing.replace(blockRe, () => block);
	}
	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	return `${existing}${prefix}${block}`;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function posixShellSnippet(): string {
	const dir = "$HOME/.codev/bin";
	const aliases = SHIM_AGENTS.map((a) => `alias ${a}="${dir}/${a}"`).join("\n");
	return `# Routes claude/codex/opencode through codev so they pick up CoDev's config.
# Remove this block to disable.
export PATH="${dir}:$PATH"
${aliases}
`;
}

function fishShellSnippet(): string {
	const dir = "$HOME/.codev/bin";
	const aliases = SHIM_AGENTS.map((a) => `alias ${a} "${dir}/${a}"`).join("\n");
	return `# Routes claude/codex/opencode through codev so they pick up CoDev's config.
# Remove this block to disable.
fish_add_path -p ${dir}
${aliases}
`;
}

function powershellSnippet(): string {
	const dir = "$HOME\\.codev\\bin";
	const functions = SHIM_AGENTS.map(
		(a) => `function ${a} { & "${dir}\\${a}.cmd" @args }`,
	).join("\n");
	return `# Routes claude/codex/opencode through codev so they pick up CoDev's config.
# Remove this block to disable.
$env:PATH = "${dir}" + [IO.Path]::PathSeparator + $env:PATH
${functions}
`;
}

function updateRcFile(path: string, snippet: string, create: boolean): boolean {
	const exists = existsSync(path);
	if (!exists && !create) return false;
	const existing = exists ? readFileSync(path, "utf-8") : "";
	const next = applySentinelBlock(existing, snippet);
	if (next === existing) return false;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, next);
	return true;
}

function patchUnixRcs(): string[] {
	const home = homedir();
	const updated: string[] = [];
	const snippet = posixShellSnippet();
	// zsh/bash rc files: always create-or-update — they're the universal shells
	// on Unix and the user may switch into them at any time.
	for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
		const path = join(home, name);
		if (updateRcFile(path, snippet, true)) updated.push(path);
	}
	// fish: only touch if the user already has a fish config dir, to avoid
	// littering homes of users who don't use fish.
	const fishDir = join(home, ".config", "fish");
	if (existsSync(fishDir)) {
		const path = join(fishDir, "config.fish");
		if (updateRcFile(path, fishShellSnippet(), true)) updated.push(path);
	}
	return updated;
}

function patchWindowsProfiles(): string[] {
	const home = homedir();
	const snippet = powershellSnippet();
	const updated: string[] = [];
	const profiles = [
		join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(
			home,
			"Documents",
			"WindowsPowerShell",
			"Microsoft.PowerShell_profile.ps1",
		),
	];
	for (const path of profiles) {
		if (updateRcFile(path, snippet, true)) updated.push(path);
	}
	return updated;
}

// Reads the user-scope Windows PATH from the registry and prepends our shim dir
// if not already present. Uses PowerShell rather than `setx` to avoid setx's
// 1024-char truncation and its habit of concatenating the volatile session PATH.
function updateWindowsUserPath(): boolean {
	const dir = join(homedir(), ".codev", "bin");
	const script = [
		"$ErrorActionPreference='Stop'",
		"$dir = [Environment]::GetFolderPath('UserProfile') + '\\.codev\\bin'",
		"$cur = [Environment]::GetEnvironmentVariable('Path','User')",
		"if ($null -eq $cur) { $cur = '' }",
		"$parts = $cur.Split([IO.Path]::PathSeparator)",
		"if ($parts -contains $dir) { Write-Output 'unchanged'; exit 0 }",
		"$new = if ($cur.Length -gt 0) { $dir + [IO.Path]::PathSeparator + $cur } else { $dir }",
		"[Environment]::SetEnvironmentVariable('Path', $new, 'User')",
		"Write-Output 'updated'",
	].join("; ");
	try {
		const out = execFileSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ encoding: "utf-8" },
		);
		return out.trim() === "updated";
	} catch {
		// Fall back to a best-effort setx if PowerShell isn't available.
		try {
			execFileSync("setx", ["PATH", `${dir};%PATH%`], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	}
}

export function activationHint(): string {
	if (process.platform === "win32") {
		return "Restart your terminal to apply.";
	}
	return "Run `exec $SHELL` to apply (or open a new terminal).";
}

export function installShims(): ShimResult {
	const shimsWritten = writeShimFiles();
	const rcFilesUpdated: string[] = [];
	let windowsUserPathUpdated = false;
	if (process.platform === "win32") {
		rcFilesUpdated.push(...patchWindowsProfiles());
		windowsUserPathUpdated = updateWindowsUserPath();
	} else {
		rcFilesUpdated.push(...patchUnixRcs());
	}
	return {
		shimDir: shimDir(),
		shimsWritten,
		rcFilesUpdated,
		windowsUserPathUpdated,
	};
}

export interface UninstallResult {
	shimDir: string;
	shimsRemoved: string[];
	rcFilesUpdated: string[];
	windowsUserPathUpdated: boolean;
}

function removeShimFiles(): string[] {
	const dir = shimDir();
	if (!existsSync(dir)) return [];
	const removed: string[] = [];
	for (const agent of SHIM_AGENTS) {
		const name = process.platform === "win32" ? `${agent}.cmd` : agent;
		const path = join(dir, name);
		if (existsSync(path)) {
			rmSync(path, { force: true });
			removed.push(path);
		}
	}
	// Remove the shim dir if it's now empty. Leave $HOME/.codev intact since
	// other codev state lives there (auth.json, logs/).
	try {
		rmdirSync(dir);
	} catch {
		// Non-empty (e.g. user added their own files) — leave it.
	}
	return removed;
}

function stripSentinelBlock(existing: string): string {
	const blockRe = new RegExp(
		`${escapeRegExp(SENTINEL_START)}[\\s\\S]*?${escapeRegExp(SENTINEL_END)}\\n?`,
	);
	return existing.replace(blockRe, "");
}

function unpatchRcFile(path: string): boolean {
	if (!existsSync(path)) return false;
	const existing = readFileSync(path, "utf-8");
	const next = stripSentinelBlock(existing);
	if (next === existing) return false;
	writeFileSync(path, next);
	return true;
}

function unpatchUnixRcs(): string[] {
	const home = homedir();
	const updated: string[] = [];
	for (const name of [".zshrc", ".bashrc", ".bash_profile"]) {
		if (unpatchRcFile(join(home, name))) updated.push(join(home, name));
	}
	const fishPath = join(home, ".config", "fish", "config.fish");
	if (unpatchRcFile(fishPath)) updated.push(fishPath);
	return updated;
}

function unpatchWindowsProfiles(): string[] {
	const home = homedir();
	const updated: string[] = [];
	const profiles = [
		join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
		join(
			home,
			"Documents",
			"WindowsPowerShell",
			"Microsoft.PowerShell_profile.ps1",
		),
	];
	for (const path of profiles) {
		if (unpatchRcFile(path)) updated.push(path);
	}
	return updated;
}

// Removes our shim dir from the user-scope Windows PATH. Best-effort: returns
// false if PowerShell is unavailable or the entry wasn't present.
function removeFromWindowsUserPath(): boolean {
	const script = [
		"$ErrorActionPreference='Stop'",
		"$dir = [Environment]::GetFolderPath('UserProfile') + '\\.codev\\bin'",
		"$cur = [Environment]::GetEnvironmentVariable('Path','User')",
		"if ($null -eq $cur -or $cur.Length -eq 0) { Write-Output 'unchanged'; exit 0 }",
		"$sep = [IO.Path]::PathSeparator",
		"$parts = $cur.Split($sep) | Where-Object { $_ -ne $dir }",
		"$new = [string]::Join($sep, $parts)",
		"if ($new -eq $cur) { Write-Output 'unchanged'; exit 0 }",
		"[Environment]::SetEnvironmentVariable('Path', $new, 'User')",
		"Write-Output 'updated'",
	].join("; ");
	try {
		const out = execFileSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ encoding: "utf-8" },
		);
		return out.trim() === "updated";
	} catch {
		return false;
	}
}

export function uninstallShims(): UninstallResult {
	const shimsRemoved = removeShimFiles();
	const rcFilesUpdated: string[] = [];
	let windowsUserPathUpdated = false;
	if (process.platform === "win32") {
		rcFilesUpdated.push(...unpatchWindowsProfiles());
		windowsUserPathUpdated = removeFromWindowsUserPath();
	} else {
		rcFilesUpdated.push(...unpatchUnixRcs());
	}
	return {
		shimDir: shimDir(),
		shimsRemoved,
		rcFilesUpdated,
		windowsUserPathUpdated,
	};
}
