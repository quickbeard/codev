import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProxyUrl } from "@/components/ProxyUrl.js";

const ARROW_DOWN = "[B";
const BACKSPACE = String.fromCharCode(127);

async function tick() {
	await new Promise((r) => setTimeout(r, 30));
}

afterEach(() => {
	cleanup();
});

describe("ProxyUrl", () => {
	test("renders both options", () => {
		const { lastFrame } = render(<ProxyUrl onDone={vi.fn()} />);
		const output = lastFrame() ?? "";
		expect(output).toContain("Use default CoDev proxy URL");
		expect(output).toContain("Use my own proxy URL");
	});

	test("Enter on default option calls onDone(null)", async () => {
		const onDone = vi.fn();
		const { stdin } = render(<ProxyUrl onDone={onDone} />);

		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(null);
	});

	test("selecting custom reveals the URL input field", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("Proxy URL:");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("submitting a valid custom URL strips trailing slashes", async () => {
		const onDone = vi.fn();
		const { stdin } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("https://custom.example.com/proxy///");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith("https://custom.example.com/proxy");
	});

	test("submits unchanged URL when no trailing slash present", async () => {
		const onDone = vi.fn();
		const { stdin } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("https://custom.example.com/proxy");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledWith("https://custom.example.com/proxy");
	});

	test("Enter on an empty URL shows an error and does not submit", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("URL is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("rejects a malformed URL", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("not a url");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("valid URL");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("rejects a non-http(s) scheme", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("ftp://example.com");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("http or https");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("backspace removes the last character in the URL field", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onDone={onDone} />);

		stdin.write(ARROW_DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("https://abc");
		await tick();
		stdin.write(BACKSPACE);
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("https://ab");
		const urlLine = output.split("\n").find((l) => l.includes("Proxy URL"));
		expect(urlLine).toBeDefined();
		expect(urlLine).not.toMatch(/https:\/\/abc/);
	});

	test("readOnly ignores all input and renders the saved choice", () => {
		const onDone = vi.fn();
		const { lastFrame } = render(
			<ProxyUrl onDone={onDone} readOnly={true} selected="custom" />,
		);
		expect(lastFrame() ?? "").toContain("Use my own proxy URL");
		expect(onDone).not.toHaveBeenCalled();
	});
});
