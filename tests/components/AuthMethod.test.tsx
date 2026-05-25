import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthMethod } from "@/components/AuthMethod.js";

const DOWN = `${String.fromCharCode(27)}[B`;
const UP = `${String.fromCharCode(27)}[A`;

// `cleanup()` from ink-testing-library can take >10 s on a heavily-loaded
// Windows CI runner (vitest's default hookTimeout). Bumping the hook to 30 s
// covers the worst-case observed (~19 s wall-clock); genuine hangs still
// surface.
afterEach(() => {
	cleanup();
}, 30_000);

describe("AuthMethod", () => {
	test("renders all options", () => {
		const onSelect = vi.fn();
		const { lastFrame } = render(<AuthMethod onSelect={onSelect} />);
		const output = lastFrame() ?? "";
		expect(output).toContain("Get a new API Key");
		expect(output).toContain("I have my own API Key");
		expect(output).toContain("Skip configuration");
	});

	test("Enter picks 'new' (default cursor at index 0)", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("new");
	});

	test("down arrow + Enter picks manual", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("manual");
	});

	test("down then up returns cursor to 'new'", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(UP);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("new");
	});

	test("down arrow does not move past the last option", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		// Press down many times — cursor should clamp at the last option ("skip").
		for (let i = 0; i < 5; i++) {
			stdin.write(DOWN);
			await new Promise((r) => setTimeout(r, 10));
		}
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("skip");
	});

	test("down twice + Enter picks 'skip'", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(<AuthMethod onSelect={onSelect} />);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("skip");
	});

	test("readOnly ignores keyboard input", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(
			<AuthMethod onSelect={onSelect} readOnly={true} />,
		);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).not.toHaveBeenCalled();
	});

	test("renders the selected option with a filled marker", () => {
		const onSelect = vi.fn();
		const { lastFrame } = render(
			<AuthMethod onSelect={onSelect} selected="manual" readOnly={true} />,
		);
		const output = lastFrame() ?? "";
		// The selected option gets "●"; unchosen options get "○".
		const manualLineHasFilled = output
			.split("\n")
			.some((line) => line.includes("●") && line.includes("I have my own"));
		expect(manualLineHasFilled).toBe(true);
	});

	test("hasExisting=true renders three options with 'existing' first", () => {
		const onSelect = vi.fn();
		const { lastFrame } = render(
			<AuthMethod onSelect={onSelect} hasExisting={true} />,
		);
		const output = lastFrame() ?? "";
		expect(output).toContain("Reuse existing API Key");
		expect(output).toContain("Get a new API Key");
		expect(output).toContain("I have my own API Key");

		const lines = output.split("\n");
		const existingIdx = lines.findIndex((l) =>
			l.includes("Reuse existing API Key"),
		);
		const newIdx = lines.findIndex((l) => l.includes("Get a new API Key"));
		const manualIdx = lines.findIndex((l) => l.includes("I have my own"));
		expect(existingIdx).toBeLessThan(newIdx);
		expect(newIdx).toBeLessThan(manualIdx);
	});

	test("hasExisting=true: Enter picks 'existing' (default cursor at index 0)", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(
			<AuthMethod onSelect={onSelect} hasExisting={true} />,
		);

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith("existing");
	});

	test("hasExisting=true: down + Enter picks 'new'", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(
			<AuthMethod onSelect={onSelect} hasExisting={true} />,
		);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("new");
	});

	test("hasExisting=true: down twice + Enter picks 'manual'", async () => {
		const onSelect = vi.fn();
		const { stdin } = render(
			<AuthMethod onSelect={onSelect} hasExisting={true} />,
		);

		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write(DOWN);
		await new Promise((r) => setTimeout(r, 30));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(onSelect).toHaveBeenCalledWith("manual");
	});
});
