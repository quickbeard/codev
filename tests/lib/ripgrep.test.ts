import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CODE_DOWNLOADS_URL } from "@/lib/const.js";
import {
	installRipgrep,
	RG_VERSION,
	ripgrepCachePath,
	ripgrepDownloadUrl,
} from "@/lib/ripgrep.js";

let tempCache: string;
beforeEach(() => {
	tempCache = mkdtempSync(join(tmpdir(), "codev-ripgrep-"));
	// Pin the cache root so tests never touch the real ~/.cache/codev.
	vi.stubEnv("XDG_CACHE_HOME", tempCache);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempCache, { recursive: true, force: true });
});

const rgName = process.platform === "win32" ? "rg.exe" : "rg";

describe("ripgrepCachePath", () => {
	test("resolves inside $XDG_CACHE_HOME/codev/bin", () => {
		expect(ripgrepCachePath()).toBe(join(tempCache, "codev", "bin", rgName));
	});

	test("falls back to ~/.cache without XDG_CACHE_HOME", () => {
		vi.stubEnv("XDG_CACHE_HOME", "");
		vi.stubEnv("HOME", tempCache);
		vi.stubEnv("USERPROFILE", tempCache);
		expect(ripgrepCachePath()).toBe(
			join(tempCache, ".cache", "codev", "bin", rgName),
		);
	});
});

describe("ripgrepDownloadUrl", () => {
	// Every platform the suite runs on (darwin/linux/win32, x64/arm64) has a
	// hosted binary, so the URL is always concrete here.
	test("points at the landing page downloads dir, pinned version", () => {
		const url = ripgrepDownloadUrl();
		expect(url).not.toBeNull();
		expect(url).toBe(
			`${CODE_DOWNLOADS_URL}/rg-${RG_VERSION}-${process.platform}-${process.arch}${
				process.platform === "win32" ? ".exe" : ""
			}`,
		);
	});
});

describe("installRipgrep", () => {
	test("downloads and stages an executable rg", async () => {
		const body = Buffer.from("fake-rg-binary");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(body));

		const result = await installRipgrep();

		expect(fetchSpy).toHaveBeenCalledWith(
			ripgrepDownloadUrl(),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(result.status).toBe("installed");
		expect(result.path).toBe(ripgrepCachePath());
		expect(readFileSync(ripgrepCachePath())).toEqual(body);
		// No .partial left behind once the rename landed.
		expect(existsSync(`${ripgrepCachePath()}.partial`)).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(ripgrepCachePath()).mode & 0o111).not.toBe(0);
		}
	});

	test("leaves an existing cached rg alone without fetching", async () => {
		const target = ripgrepCachePath();
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "user-provided-rg");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await installRipgrep();

		expect(result).toEqual({ status: "present", path: target });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(readFileSync(target, "utf-8")).toBe("user-provided-rg");
	});

	test("rejects on an HTTP error and stages nothing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("blocked", { status: 403 }),
		);

		await expect(installRipgrep()).rejects.toThrow(
			/ripgrep download failed \(403\)/,
		);
		expect(existsSync(ripgrepCachePath())).toBe(false);
		expect(existsSync(`${ripgrepCachePath()}.partial`)).toBe(false);
	});

	test("rejects on an empty body and stages nothing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(Buffer.alloc(0)),
		);

		await expect(installRipgrep()).rejects.toThrow(/empty/);
		expect(existsSync(ripgrepCachePath())).toBe(false);
	});
});
