import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	COMPACT_RESERVED,
	compactPct,
	DEFAULT_LIMITS,
	DEFAULT_OUTPUT_TOKENS,
	declaredInput,
	limitsFor,
	limitsFromWindow,
	type ModelLimits,
	outputTokens,
	resetModelLimitsCache,
} from "@/lib/model-limits.js";

let tempDir: string;

function writeCachedLimits(limits: Record<string, ModelLimits>): void {
	const dir = join(tempDir, ".codev-hub");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ model_limits: limits }),
	);
	// The remote map is read once per process; drop the memo so this write is
	// the one the next limitsFor() call sees.
	resetModelLimitsCache();
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-model-limits-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	resetModelLimitsCache();
});

afterEach(() => {
	vi.unstubAllEnvs();
	resetModelLimitsCache();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("limitsFor", () => {
	test("returns the table entry for a known model", () => {
		expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({
			context: 1000000,
			trigger: 800000,
		});
		expect(limitsFor("zai-org/GLM-4.7-cc")).toEqual({
			context: 200000,
			trigger: 160000,
		});
	});

	test("falls back to the 200K default for an unrecognized model", () => {
		expect(limitsFor("some/model-nobody-has-heard-of")).toEqual(DEFAULT_LIMITS);
	});

	test("MiniMax-M2.7 is covered by the default rather than its own entry", () => {
		// Intentionally absent from the table — the default already describes it.
		expect(limitsFor("MiniMax/MiniMax-M2.7")).toEqual({
			context: 200000,
			trigger: 160000,
		});
	});

	test("a gateway-reported window outranks the table", () => {
		writeCachedLimits({
			"MiniMax/MiniMax-M3": { context: 524288, trigger: 419430 },
		});
		expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({
			context: 524288,
			trigger: 419430,
		});
	});

	test("a model the gateway says nothing about still gets the table entry", () => {
		writeCachedLimits({ "other/model": { context: 12345, trigger: 9876 } });
		expect(limitsFor("zai-org/GLM-4.7-cc")).toEqual({
			context: 200000,
			trigger: 160000,
		});
	});

	test("an absent cache file is not an error", () => {
		expect(limitsFor("MiniMax/MiniMax-M3")).toEqual({
			context: 1000000,
			trigger: 800000,
		});
	});
});

describe("limitsFromWindow", () => {
	test("derives the trigger at 80% of a gateway-reported window", () => {
		expect(limitsFromWindow(1000000)).toEqual({
			context: 1000000,
			trigger: 800000,
		});
	});

	test("carries an output cap through when the gateway reports one", () => {
		expect(limitsFromWindow(200000, 8192)).toEqual({
			context: 200000,
			trigger: 160000,
			output: 8192,
		});
	});

	test("omits output entirely when the gateway reports none", () => {
		expect(limitsFromWindow(200000)).not.toHaveProperty("output");
	});
});

describe("compactPct", () => {
	test("expresses the trigger as a whole percentage of the window", () => {
		expect(compactPct({ context: 1000000, trigger: 800000 })).toBe(80);
		expect(compactPct({ context: 200000, trigger: 160000 })).toBe(80);
	});

	test("rounds a trigger that isn't a whole percentage of its window", () => {
		expect(compactPct({ context: 196608, trigger: 167117 })).toBe(85);
	});
});

describe("declaredInput", () => {
	// The whole point of limit.input: OpenCode's trigger is
	// `input − reserved` with ONE global reserve, so input is the only
	// per-model lever. These are the numbers that must land on target.
	test("lands each model's trigger exactly on target under one shared reserve", () => {
		const m3 = limitsFor("MiniMax/MiniMax-M3");
		const glm = limitsFor("zai-org/GLM-4.7-cc");
		expect(declaredInput(m3) - COMPACT_RESERVED).toBe(800000);
		expect(declaredInput(glm) - COMPACT_RESERVED).toBe(160000);
	});

	test("clamps to the true window so the budget is never overstated", () => {
		// trigger + reserved (195000) exceeds the window (180000): declaring it
		// would let a session run past the model's real ceiling before
		// compacting, so the window wins and the trigger only moves earlier.
		const tight: ModelLimits = { context: 180000, trigger: 155000 };
		expect(declaredInput(tight)).toBe(180000);
		expect(declaredInput(tight) - COMPACT_RESERVED).toBeLessThan(155000);
	});
});

describe("outputTokens", () => {
	test("defaults when the model declares no output cap", () => {
		expect(outputTokens({ context: 200000, trigger: 160000 })).toBe(
			DEFAULT_OUTPUT_TOKENS,
		);
	});

	test("prefers the model's own cap", () => {
		expect(
			outputTokens({ context: 200000, trigger: 160000, output: 8192 }),
		).toBe(8192);
	});
});
