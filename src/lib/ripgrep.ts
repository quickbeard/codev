import {
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CODE_DOWNLOADS_URL } from "@/lib/const.js";
import { logInfo } from "@/lib/log.js";

// CoDev Code resolves a ripgrep binary for file search: the `@` mention index
// on Windows (where its bundled fff indexer is disabled) and the Grep/Glob
// tools everywhere. When `rg` is neither on PATH nor in its cache dir it
// downloads one from github.com/BurntSushi/ripgrep — which fails on corporate
// networks that block GitHub, leaving file search silently empty. Staging the
// binary into the cache dir here makes the agent find it before it ever tries
// GitHub.
//
// Must track the version codev-code pins in packages/core/src/ripgrep/binary.ts
// and the binaries hosted by codev-landing-page (public/docs/code/downloads).
export const RG_VERSION = "15.1.0";

// The `${process.platform}-${process.arch}` pairs with a hosted binary.
const SUPPORTED = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
]);

export interface RipgrepInstallResult {
	// installed → downloaded and staged this run; present → cache already had
	// one (never overwritten); unsupported → no hosted binary for this
	// platform/arch, nothing to do.
	status: "installed" | "present" | "unsupported";
	path: string | null;
}

// Where CoDev Code looks for a cached ripgrep before downloading its own:
// `<xdg cache>/codev/bin/rg[.exe]`. Its cache root comes from the xdg-basedir
// package — $XDG_CACHE_HOME or ~/.cache on every platform, Windows included.
export function ripgrepCachePath(): string {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(
		cacheRoot,
		"codev",
		"bin",
		process.platform === "win32" ? "rg.exe" : "rg",
	);
}

export function ripgrepDownloadUrl(): string | null {
	const key = `${process.platform}-${process.arch}`;
	if (!SUPPORTED.has(key)) return null;
	const ext = process.platform === "win32" ? ".exe" : "";
	return `${CODE_DOWNLOADS_URL}/rg-${RG_VERSION}-${key}${ext}`;
}

export async function installRipgrep(): Promise<RipgrepInstallResult> {
	const target = ripgrepCachePath();
	if (existsSync(target)) return { status: "present", path: target };
	const url = ripgrepDownloadUrl();
	if (url === null) return { status: "unsupported", path: null };

	// Bounded so a blackholing proxy can't hang the finalize step; ~4–5 MB from
	// the internal host comfortably fits.
	const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok)
		throw new Error(`ripgrep download failed (${res.status}): ${url}`);
	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length === 0) throw new Error(`ripgrep download was empty: ${url}`);

	// Write-then-rename: CoDev Code's cache check is bare file existence, so a
	// partial file left by a crash here would permanently satisfy it and brick
	// the agent's search instead of helping it.
	mkdirSync(dirname(target), { recursive: true });
	const partial = `${target}.partial`;
	writeFileSync(partial, bytes, { mode: 0o755 });
	chmodSync(partial, 0o755);
	renameSync(partial, target);
	logInfo("staged ripgrep into CoDev Code cache", {
		action: "ripgrep.install",
		extra: { path: target, url, bytes: bytes.length },
	});
	return { status: "installed", path: target };
}
