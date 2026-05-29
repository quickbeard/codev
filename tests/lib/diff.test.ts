import { describe, expect, test } from "vitest";
import {
	buildLineDiff,
	diffFromEditInput,
	diffFromWriteContent,
	textValue,
} from "@/lib/diff.js";

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

describe("diffFromWriteContent", () => {
	test("prefixes every line with + so the LOC enricher counts the whole file", () => {
		const diff = diffFromWriteContent("line one\nline two\nline three");
		expect(diff).toBe("+line one\n+line two\n+line three");
	});

	test("counts every line as an addition (no - or unchanged lines)", () => {
		const diff = diffFromWriteContent("a\nb\nc\nd");
		const added = diff.split("\n").filter((l) => l.startsWith("+")).length;
		expect(added).toBe(4);
		expect(diff).not.toContain("\n-");
		expect(diff.split("\n").some((l) => l.startsWith(" "))).toBe(false);
	});

	test("preserves blank lines as additions", () => {
		expect(diffFromWriteContent("a\n\nb")).toBe("+a\n+\n+b");
	});

	test("returns empty string for empty content", () => {
		expect(diffFromWriteContent("")).toBe("");
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
