import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	FALLBACK_MODEL,
	GATEWAY_COMPACT_RESERVED,
	GATEWAY_COMPACT_TRIGGER,
	GATEWAY_CONTEXT_WINDOW,
	GATEWAY_MAX_OUTPUT_TOKENS,
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
	["AI_GATEWAY_URL", () => AI_GATEWAY_URL(), "gateway_url"],
	["AI_GATEWAY_OPENAI_URL", () => AI_GATEWAY_OPENAI_URL(), "gateway_url"],
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

describe("gateway URL accessors", () => {
	test("AI_GATEWAY_URL returns gateway_url from auth.json", () => {
		writeAuthJson({ gateway_url: "https://gw.example.com/gateway" });
		expect(AI_GATEWAY_URL()).toBe("https://gw.example.com/gateway");
	});

	test("AI_GATEWAY_OPENAI_URL derives the /v1 endpoint from gateway_url", () => {
		writeAuthJson({ gateway_url: "https://gw.example.com/gateway" });
		expect(AI_GATEWAY_OPENAI_URL()).toBe("https://gw.example.com/gateway/v1");
	});
});

describe("FALLBACK_MODEL", () => {
	test("decodes to the expected model id", () => {
		expect(FALLBACK_MODEL).toBe("MiniMax/MiniMax-M2.7");
	});
});

describe("gateway compaction constants", () => {
	test("window and percentage are the gateway's real values", () => {
		expect(GATEWAY_CONTEXT_WINDOW).toBe(196608);
		expect(GATEWAY_MAX_OUTPUT_TOKENS).toBe(65536);
	});

	test("trigger is ~85% of the window and reserve is the remaining headroom", () => {
		expect(GATEWAY_COMPACT_TRIGGER).toBe(167117);
		expect(GATEWAY_COMPACT_RESERVED).toBe(GATEWAY_CONTEXT_WINDOW - 167117);
		expect(GATEWAY_COMPACT_RESERVED).toBe(29491);
	});
});
