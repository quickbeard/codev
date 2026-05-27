import { describe, expect, test } from "vitest";
import { formatToolList } from "@/lib/text.js";

describe("formatToolList", () => {
	test("single item renders as-is", () => {
		expect(formatToolList(["Continue"])).toBe("Continue");
	});

	test("two items join with 'and' (no comma)", () => {
		expect(formatToolList(["Claude Code", "OpenCode"])).toBe(
			"Claude Code and OpenCode",
		);
	});

	test("three items use Oxford comma", () => {
		expect(formatToolList(["Claude Code", "Codex", "OpenCode"])).toBe(
			"Claude Code, Codex, and OpenCode",
		);
	});

	test("four items use Oxford comma", () => {
		expect(
			formatToolList(["Claude Code", "Codex", "OpenCode", "Continue"]),
		).toBe("Claude Code, Codex, OpenCode, and Continue");
	});

	test("empty list is empty string", () => {
		expect(formatToolList([])).toBe("");
	});
});
