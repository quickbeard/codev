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

	test("documents the CoDev Code passthrough", () => {
		// Bare `codev` and unknown commands forward to the built-in agent;
		// the help must orient users to that before the hub command list.
		printHelp();
		expect(output()).toContain("CoDev Code");
		expect(output()).toContain("passed through");
	});

	test("lists the restore subcommand", () => {
		printHelp();
		expect(output()).toContain("restore [agent]");
	});

	test("lists the login command", () => {
		printHelp();
		expect(output()).toContain("login");
	});

	test("lists the init command", () => {
		printHelp();
		expect(output()).toContain("init");
	});

	test("lists the remove command", () => {
		printHelp();
		expect(output()).toContain("remove");
	});

	test("does not surface bare-agent launch commands as documented", () => {
		// Agents (claude/codex/opencode) are launched via PATH shims set up by
		// `codevhub install` — the bare `codev <agent>` form is intentionally
		// undocumented. Help should not advertise it. Catches regressions where
		// someone re-adds `claude   Run the CLI...`.
		printHelp();
		const out = output();
		// `restore [agent]` is fine; a bare `claude` / `codex` / `opencode` line
		// (where the agent name is the first token after the indent) is not.
		const bareAgentLine = out
			.split("\n")
			.find((line) => /^\s+(claude|codex|opencode)\b/.test(line));
		expect(bareAgentLine).toBeUndefined();
	});
});
