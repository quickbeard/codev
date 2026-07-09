import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ToolSelect } from "@/components/ToolSelect.js";

afterEach(() => {
	cleanup();
});

describe("ToolSelect", () => {
	test("renders all tool options", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("CoDev Code");
		expect(output).toContain("Claude Code");
		expect(output).toContain("OpenCode");
		expect(output).toContain("Codex");
		expect(output).toContain("Claude Code (extension)");
		expect(output).toContain("Continue (extension)");
	});

	test("emits the `claude-code-ext` sentinel when the Claude Code (extension) row is picked", async () => {
		// The extension rows are editor-agnostic; the merged editor sub-
		// select runs next. ToolSelect emits a sentinel that InstallApp
		// expands into `vscode-claude-code` and/or `jetbrains-claude-code`
		// via EditorSelect.
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Four down-arrows to reach the 5th (Claude Code (extension)) row.
		for (let i = 0; i < 4; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 50));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code-ext"]);
	});

	test("emits the `continue` sentinel when the Continue (extension) row is picked", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Five down-arrows to reach the 6th (Continue (extension)) row.
		for (let i = 0; i < 5; i++) {
			stdin.write("\x1B[B");
			await new Promise((r) => setTimeout(r, 50));
		}
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["continue"]);
	});

	test("renders unchecked checkboxes by default", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(<ToolSelect onConfirm={onConfirm} />);

		const output = lastFrame() ?? "";
		expect(output).toContain("□");
		expect(output).not.toContain("■");
	});

	test("selects tool with space", async () => {
		const onConfirm = vi.fn();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("■");
	});

	test("calls onConfirm with selected tools on enter", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// One down-arrow to reach the Claude Code row (CoDev Code sits first).
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code"]);
	});

	test("selects CoDev Code on the first row without moving the cursor", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codev-code"]);
	});

	test("does not call onConfirm when no tools selected", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("can select multiple tools", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Down to Claude Code (row 1), select, down to Codex (row 2), select.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code", "codex"]);
	});

	test("can select Codex by moving cursor down twice", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["codex"]);
	});

	test("can deselect a tool", async () => {
		const onConfirm = vi.fn();
		const { lastFrame, stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		let output = lastFrame() ?? "";
		expect(output).toContain("■");

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));

		output = lastFrame() ?? "";
		expect(output).not.toContain("■");
	});
});
