import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProxyUrl } from "@/components/ProxyUrl.js";

const DOWN = `${String.fromCharCode(27)}[B`;
const UP = `${String.fromCharCode(27)}[A`;
const BACKSPACE = String.fromCharCode(127);

async function tick() {
	await new Promise((r) => setTimeout(r, 30));
}

afterEach(() => {
	cleanup();
});

describe("ProxyUrl — choose phase", () => {
	test("renders both options", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		const output = lastFrame() ?? "";
		expect(output).toContain("Use the default proxy URL");
		expect(output).toContain("Enter a custom proxy URL");
	});

	test("Enter picks 'default' (cursor starts at index 0)", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ProxyUrl onConfirm={onConfirm} />);

		stdin.write("\r");
		await tick();

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onConfirm).toHaveBeenCalledWith({ method: "default" });
	});

	test("down + Enter opens the custom-URL input rather than firing onConfirm", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);

		stdin.write(DOWN);
		await tick();
		stdin.write("\r");
		await tick();

		expect(onConfirm).not.toHaveBeenCalled();
		const output = lastFrame() ?? "";
		expect(output).toContain("URL:");
		expect(output).toContain("Press Enter to confirm");
	});

	test("down arrow does not move past the last option", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ProxyUrl onConfirm={onConfirm} />);

		for (let i = 0; i < 5; i++) {
			stdin.write(DOWN);
			await new Promise((r) => setTimeout(r, 10));
		}
		stdin.write("\r");
		await tick();

		// Cursor clamps at the second option, so Enter opens the input — does NOT
		// roll over to "default".
		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("up arrow returns to 'default' from 'custom'", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ProxyUrl onConfirm={onConfirm} />);

		stdin.write(DOWN);
		await tick();
		stdin.write(UP);
		await tick();
		stdin.write("\r");
		await tick();

		expect(onConfirm).toHaveBeenCalledWith({ method: "default" });
	});
});

describe("ProxyUrl — input phase + URL validator", () => {
	async function enterInputPhase(stdin: { write: (s: string) => void }) {
		stdin.write(DOWN);
		await tick();
		stdin.write("\r");
		await tick();
	}

	test("typed characters appear in the URL field", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("https://my-proxy.example.com");
		await tick();

		expect(lastFrame() ?? "").toContain("https://my-proxy.example.com");
	});

	test("valid http(s) URL fires onConfirm with the trimmed value", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("  https://my-proxy.example.com  ");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onConfirm).toHaveBeenCalledWith({
			method: "custom",
			url: "https://my-proxy.example.com",
		});
	});

	test("http:// URLs are accepted", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("http://localhost:8080");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onConfirm).toHaveBeenCalledWith({
			method: "custom",
			url: "http://localhost:8080",
		});
	});

	test("empty URL shows 'URL is required' and does not fire onConfirm", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("URL is required");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("whitespace-only URL shows 'URL is required'", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("   ");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("URL is required");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("malformed URL surfaces 'Invalid URL'", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("not a url");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain("Invalid URL");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("non-http(s) scheme is rejected with the protocol error", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("ftp://example.com");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").toContain(
			"URL must start with http:// or https://",
		);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("validator re-runs after the user corrects a bad URL", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("bogus");
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").toContain("Invalid URL");

		// Clear the bad value and type a valid one. Each backspace removes one
		// char; 5 backspaces empties "bogus".
		for (let i = 0; i < 5; i++) {
			stdin.write(BACKSPACE);
			await new Promise((r) => setTimeout(r, 10));
		}
		stdin.write("https://ok.example.com");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onConfirm).toHaveBeenCalledWith({
			method: "custom",
			url: "https://ok.example.com",
		});
	});

	test("backspace removes the last character of the URL field", async () => {
		const onConfirm = vi.fn();
		const { stdin, lastFrame } = render(<ProxyUrl onConfirm={onConfirm} />);
		await enterInputPhase(stdin);

		stdin.write("abc");
		await tick();
		stdin.write(BACKSPACE);
		await tick();

		const output = lastFrame() ?? "";
		const urlLine = output.split("\n").find((l) => l.includes("URL:"));
		expect(urlLine).toBeDefined();
		expect(urlLine).not.toMatch(/abc/);
		expect(urlLine).toMatch(/ab/);
	});
});

describe("ProxyUrl — readOnly", () => {
	test("ignores all keyboard input", async () => {
		const onConfirm = vi.fn();
		const { stdin } = render(
			<ProxyUrl onConfirm={onConfirm} readOnly={true} />,
		);

		stdin.write(DOWN);
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("https://x.example.com");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onConfirm).not.toHaveBeenCalled();
	});

	test("renders 'default' selection with a filled marker and no URL line", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<ProxyUrl
				onConfirm={onConfirm}
				readOnly={true}
				selected={{ method: "default" }}
			/>,
		);
		const output = lastFrame() ?? "";
		const defaultLine = output
			.split("\n")
			.find((l) => l.includes("Use the default"));
		expect(defaultLine).toBeDefined();
		expect(defaultLine).toContain("●");
		expect(output).not.toContain("URL: ");
	});

	test("renders 'custom' selection with the chosen URL", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<ProxyUrl
				onConfirm={onConfirm}
				readOnly={true}
				selected={{
					method: "custom",
					url: "https://chosen.example.com",
				}}
			/>,
		);
		const output = lastFrame() ?? "";
		const customLine = output
			.split("\n")
			.find((l) => l.includes("Enter a custom"));
		expect(customLine).toBeDefined();
		expect(customLine).toContain("●");
		expect(output).toContain("https://chosen.example.com");
	});
});
