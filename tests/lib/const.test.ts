import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	FALLBACK_MODEL,
	SUPABASE_ANON_KEY,
	SUPABASE_URL,
} from "@/lib/const.js";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-const-"));
	vi.stubEnv("HOME", tempDir);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeAuthJson(data: Record<string, unknown>) {
	const dir = join(tempDir, ".codev");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(data));
}

const ACCESSORS: ReadonlyArray<
	readonly [name: string, fn: () => string, field: string]
> = [
	["SUPABASE_URL", () => SUPABASE_URL(), "supabase_url"],
	["SUPABASE_ANON_KEY", () => SUPABASE_ANON_KEY(), "supabase_anon_key"],
];

describe("Supabase const accessors", () => {
	test("each returns its field from auth.json", () => {
		writeAuthJson({
			supabase_url: "https://x.supabase.co",
			supabase_anon_key: "anon-x",
		});
		expect(SUPABASE_URL()).toBe("https://x.supabase.co");
		expect(SUPABASE_ANON_KEY()).toBe("anon-x");
	});

	for (const [name, fn, field] of ACCESSORS) {
		test(`${name} hard-fails with field name + install hint when missing`, () => {
			writeAuthJson({});
			let err: unknown;
			try {
				fn();
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(Error);
			const msg = (err as Error).message;
			expect(msg).toContain(field);
			expect(msg).toContain("Run `codev install`");
		});

		test(`${name} hard-fails when auth.json does not exist`, () => {
			expect(fn).toThrow(/Run `codev install`/);
		});

		test(`${name} hard-fails when its field is empty string`, () => {
			writeAuthJson({ [field]: "" });
			expect(fn).toThrow(field);
		});
	}

	test("each accessor reads the live file (no module-load caching)", () => {
		writeAuthJson({
			supabase_url: "https://first.supabase.co",
			supabase_anon_key: "a1",
		});
		expect(SUPABASE_URL()).toBe("https://first.supabase.co");

		writeAuthJson({
			supabase_url: "https://second.supabase.co",
			supabase_anon_key: "a2",
		});
		expect(SUPABASE_URL()).toBe("https://second.supabase.co");
	});
});

describe("FALLBACK_MODEL", () => {
	test("decodes to the expected model id", () => {
		expect(FALLBACK_MODEL).toBe("MiniMax/MiniMax-M2.7");
	});
});
