import { describe, expect, test } from "vitest";
import { buildLineDiff, diffFromEditInput, textValue } from "@/lib/diff.js";

describe("buildLineDiff", () => {
	test("returns LCS-style diff: unchanged lines get a leading space, changes get -/+", () => {
		const diff = buildLineDiff("a\nb\nc", "a\nB\nc");
		// Anchored to LCS behaviour — naive -all/+all would produce 6 lines.
		expect(diff).toBe(" a\n-b\n+B\n c");
	});

	test("treats empty oldText as a single empty line removal", () => {
		// "".split("\n") yields [""], so the empty line is walked as a removal
		// before the new lines are appended.
		expect(buildLineDiff("", "one\ntwo")).toBe("-\n+one\n+two");
	});

	test("treats empty newText as a single empty line insertion", () => {
		expect(buildLineDiff("one\ntwo", "")).toBe("-one\n-two\n+");
	});

	test("preserves unchanged blocks instead of dumping every line as -/+", () => {
		const oldText = "alpha\nbeta\ngamma\ndelta";
		const newText = "alpha\nBETA\ngamma\ndelta";
		const diff = buildLineDiff(oldText, newText);
		expect(diff).toContain(" alpha");
		expect(diff).toContain("-beta");
		expect(diff).toContain("+BETA");
		expect(diff).toContain(" gamma");
		expect(diff).toContain(" delta");
		// Critical regression guard: a naive every-old-as- / every-new-as+ diff
		// would mark every line as changed.
		expect(diff).not.toContain("-alpha");
		expect(diff).not.toContain("-gamma");
		expect(diff).not.toContain("+gamma");
	});
});

describe("diffFromEditInput", () => {
	test("reads snake_case old_string/new_string (Claude Code / Codex shape)", () => {
		const diff = diffFromEditInput({
			old_string: "foo\nbar",
			new_string: "foo\nBAR",
		});
		expect(diff).toBe(" foo\n-bar\n+BAR");
	});

	test("reads camelCase oldString/newString (OpenCode shape)", () => {
		const diff = diffFromEditInput({
			oldString: "foo\nbar",
			newString: "foo\nBAR",
		});
		expect(diff).toBe(" foo\n-bar\n+BAR");
	});

	test("returns empty string when neither shape is present", () => {
		expect(diffFromEditInput({})).toBe("");
		expect(diffFromEditInput({ unrelated: 1 })).toBe("");
	});

	test("ignores non-string values", () => {
		expect(diffFromEditInput({ old_string: 5, new_string: false })).toBe("");
	});
});

describe("textValue", () => {
	test("returns the string when input is a string", () => {
		expect(textValue("hello")).toBe("hello");
	});

	test("returns empty string for non-strings", () => {
		expect(textValue(undefined)).toBe("");
		expect(textValue(null)).toBe("");
		expect(textValue(42)).toBe("");
		expect(textValue({})).toBe("");
	});
});
