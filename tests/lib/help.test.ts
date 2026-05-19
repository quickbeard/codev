import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VERSION } from "@/lib/const.js";
import { printHelp, printVersion } from "@/lib/help.js";

let logSpy: MockInstance;

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
});

function output(): string {
	return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

describe("printVersion", () => {
	test("prints the version string", () => {
		printVersion();
		expect(output().trim()).toBe(VERSION);
	});

	test("does not print the help banner", () => {
		printVersion();
		expect(output()).not.toContain("Usage: codev");
	});
});

describe("printHelp", () => {
	test("does not include the version string", () => {
		printHelp();
		expect(output()).not.toContain(VERSION);
	});

	test("lists the --version flag", () => {
		printHelp();
		expect(output()).toContain("--version");
	});

	test("prints the usage line", () => {
		printHelp();
		expect(output()).toContain("Usage: codev");
	});

	test("lists the --restore form for each agent", () => {
		printHelp();
		const out = output();
		expect(out).toContain("claude --restore");
		expect(out).toContain("codex --restore");
		expect(out).toContain("opencode --restore");
	});

	test("only surfaces agent commands as --restore forms", () => {
		// Agents (claude/codex/opencode) are launched via PATH shims set up by
		// `codev install` — the bare `codev <agent>` form is intentionally
		// undocumented. Verify structurally: every line that mentions an agent
		// binary name also names a --restore (or another non-launch operation),
		// catching regressions where someone re-adds `claude   Run the CLI...`.
		printHelp();
		const agentLines = output()
			.split("\n")
			.filter((line) => /\b(claude|codex|opencode)\b/.test(line));
		expect(agentLines.length).toBeGreaterThan(0);
		for (const line of agentLines) {
			expect(line).toContain("--restore");
		}
	});
});
