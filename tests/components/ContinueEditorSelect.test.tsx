import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ContinueEditorSelect } from "@/components/ContinueEditorSelect.js";

afterEach(() => {
	cleanup();
});

describe("ContinueEditorSelect", () => {
	test("renders both editor options unchecked by default", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<ContinueEditorSelect onConfirm={onConfirm} />,
		);
		const output = lastFrame() ?? "";
		expect(output).toContain("VS Code");
		expect(output).toContain("JetBrains");
		expect(output).toContain("□");
		expect(output).not.toContain("■");
	});

	test("does not emit until at least one editor is selected", async () => {
		// Pressing Enter with an empty selection must be a no-op — otherwise
		// InstallApp would advance with no editor Tools to expand into.
		const onConfirm = vi.fn();
		const { stdin } = render(<ContinueEditorSelect onConfirm={onConfirm} />);
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));
		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("emits the chosen editor Tool(s) on Enter", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ContinueEditorSelect onConfirm={onConfirm} />);

		// Cursor starts at VS Code (row 0); space toggles, Enter submits.
		stdin.write(" ");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith(["vscode-continue"]);
	});

	test("can pick both editors", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ContinueEditorSelect onConfirm={onConfirm} />);

		stdin.write(" "); // VS Code
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\x1B[B"); // move down to JetBrains row
		await new Promise((r) => setTimeout(r, 50));
		stdin.write(" "); // JetBrains
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(onConfirm).toHaveBeenCalledWith([
			"vscode-continue",
			"jetbrains-continue",
		]);
	});
});
