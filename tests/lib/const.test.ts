import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	ANALYSIS_BACKEND_ANON_KEY,
	ANALYSIS_BACKEND_URL,
	FALLBACK_MODEL,
	GATEWAY_COMPACT_RESERVED,
	GATEWAY_COMPACT_TRIGGER,
	GATEWAY_CONTEXT_WINDOW,
	GATEWAY_MAX_OUTPUT_TOKENS,
	MIN_NODE_STRING,
	nodeVersionMeets,
	parseNodeVersion,
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
	const dir = join(tempDir, ".codev-hub");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(data));
}

const ACCESSORS: ReadonlyArray<
	readonly [name: string, fn: () => string, field: string]
> = [
	["ANALYSIS_BACKEND_URL", () => ANALYSIS_BACKEND_URL(), "supabase_url"],
	[
		"ANALYSIS_BACKEND_ANON_KEY",
		() => ANALYSIS_BACKEND_ANON_KEY(),
		"supabase_anon_key",
	],
	["AI_GATEWAY_URL", () => AI_GATEWAY_URL(), "gateway_url"],
	["AI_GATEWAY_OPENAI_URL", () => AI_GATEWAY_OPENAI_URL(), "gateway_url"],
];

describe("analysis backend const accessors", () => {
	test("each returns its field from auth.json", () => {
		writeAuthJson({
			supabase_url: "https://x.analysis.example.com",
			supabase_anon_key: "anon-x",
		});
		expect(ANALYSIS_BACKEND_URL()).toBe("https://x.analysis.example.com");
		expect(ANALYSIS_BACKEND_ANON_KEY()).toBe("anon-x");
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
			expect(msg).toContain("Run `codevhub install`");
		});

		test(`${name} hard-fails when auth.json does not exist`, () => {
			expect(fn).toThrow(/Run `codevhub install`/);
		});

		test(`${name} hard-fails when its field is empty string`, () => {
			writeAuthJson({ [field]: "" });
			expect(fn).toThrow(field);
		});
	}

	test("each accessor reads the live file (no module-load caching)", () => {
		writeAuthJson({
			supabase_url: "https://first.analysis.example.com",
			supabase_anon_key: "a1",
		});
		expect(ANALYSIS_BACKEND_URL()).toBe("https://first.analysis.example.com");

		writeAuthJson({
			supabase_url: "https://second.analysis.example.com",
			supabase_anon_key: "a2",
		});
		expect(ANALYSIS_BACKEND_URL()).toBe("https://second.analysis.example.com");
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

// This gate decides whether the CLI runs at all, and the boundary is an
// oddly specific patch release: 22.21.0 is where HTTP_PROXY support was
// backported to the Node 22 line. A naive `major < 22 || minor < 21` compare
// would wrongly reject every 23.x and 24.x, so pin both directions.
describe("Node version gate", () => {
	test("parses a v-prefixed version", () => {
		expect(parseNodeVersion("v24.15.0")).toEqual([24, 15, 0]);
		expect(parseNodeVersion("22.21.0")).toEqual([22, 21, 0]);
	});

	test.each([
		["22.21.0", true],
		["22.21.1", true],
		["22.22.0", true],
		["v24.15.0", true],
		// Newer majors must pass even though their minor is below 21.
		["23.0.0", true],
		["24.0.0", true],
		["24.5.0", true],
		["22.20.9", false],
		["22.5.0", false],
		["22.0.0", false],
		["21.99.99", false],
		["20.11.0", false],
	])("%s meets the floor: %s", (version, expected) => {
		expect(nodeVersionMeets(version)).toBe(expected);
	});

	test("the floor string matches what the comparison enforces", () => {
		expect(nodeVersionMeets(MIN_NODE_STRING)).toBe(true);
		const [major, minor, patch] = parseNodeVersion(MIN_NODE_STRING);
		expect(nodeVersionMeets(`${major}.${minor}.${patch - 1}`)).toBe(false);
	});

	test("the suite's own Node satisfies the gate it ships", () => {
		expect(nodeVersionMeets(process.versions.node)).toBe(true);
	});
});
