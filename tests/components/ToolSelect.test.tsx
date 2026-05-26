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
		expect(output).toContain("Claude Code");
		expect(output).toContain("OpenCode");
		expect(output).toContain("Codex");
		expect(output).toContain("Continue");
	});

	test("emits the `continue` sentinel when the Continue row is picked", async () => {
		// The Continue row is editor-agnostic; the editor sub-select runs
		// next. ToolSelect emits a sentinel that InstallApp expands into
		// `vscode-continue` and/or `jetbrains-continue` via ContinueEditorSelect.
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

		// Three down-arrows to reach the 4th (Continue) row.
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\x1B[B");
		await new Promise((r) => setTimeout(r, 50));
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

		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["claude-code"]);
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

	test("can select Codex by moving cursor down once", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ToolSelect onConfirm={onConfirm} />);

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
