import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ManualCredentials } from "@/components/ManualCredentials.js";

const BACKSPACE = String.fromCharCode(127);

async function tick() {
	await new Promise((r) => setTimeout(r, 30));
}

afterEach(() => {
	cleanup();
});

describe("ManualCredentials", () => {
	test("renders all three field labels", () => {
		const onDone = vi.fn();
		const { lastFrame } = render(<ManualCredentials onDone={onDone} />);
		const output = lastFrame() ?? "";
		expect(output).toContain("Provider Name");
		expect(output).toContain("API URL");
		expect(output).toContain("API Key");
	});

	test("typed characters appear in the active field", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("Acme AI");
		await tick();

		expect(lastFrame() ?? "").toContain("Acme AI");
	});

	test("shows the id derived from the provider name as it is typed", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("Acme AI Gateway");
		await tick();

		expect(lastFrame() ?? "").toContain("→ id: acme-ai-gateway");
	});

	test("Enter advances through all three fields and submits", async () => {
		const onDone = vi.fn();
		const { stdin } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("Acme AI");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("https://example.com/v1");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("sk-test");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith({
			providerName: "Acme AI",
			baseUrl: "https://example.com/v1",
			apiKey: "sk-test",
		});
	});

	test("trims surrounding whitespace from submitted values", async () => {
		const onDone = vi.fn();
		const { stdin } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("  Acme AI  ");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("  https://example.com  ");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write(" sk-key ");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledWith({
			providerName: "Acme AI",
			baseUrl: "https://example.com",
			apiKey: "sk-key",
		});
	});

	test("an empty provider name advances and submits as ''", async () => {
		// The caller resolves "" to the default provider identity; the form itself
		// only has to let it through.
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").not.toContain("Provider Name is required");

		stdin.write("https://example.com");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("sk-key");
		await tick();
		stdin.write("\r");
		await tick();

		expect(onDone).toHaveBeenCalledWith({
			providerName: "",
			baseUrl: "https://example.com",
			apiKey: "sk-key",
		});
	});

	test("ignores non-ASCII characters in the provider name", async () => {
		// The name is the source of a TOML/JSON config key, so anything the slug
		// couldn't represent never enters the field.
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("Cổng Ai");
		await tick();

		const nameLine = (lastFrame() ?? "")
			.split("\n")
			.find((l) => l.includes("Provider Name"));
		expect(nameLine).toContain("Cng Ai");
		expect(nameLine).not.toContain("ổ");
	});

	test("Enter on an empty API URL shows an error and does not advance", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("\r");
		await tick();
		stdin.write("\r");
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("API URL is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("Enter on an all-whitespace API URL shows the required error", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("\r");
		await tick();
		stdin.write("   ");
		await tick();
		stdin.write("\r");
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("API URL is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("backspace removes the last character of the active field", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		stdin.write("\r");
		await tick();
		stdin.write("abc");
		await tick();
		stdin.write(BACKSPACE);
		await tick();

		const output = lastFrame() ?? "";
		expect(output).toContain("ab");
		// The trailing "c" should no longer appear on the API URL line.
		const urlLine = output.split("\n").find((l) => l.includes("API URL"));
		expect(urlLine).toBeDefined();
		expect(urlLine).not.toMatch(/abc/);
	});

	test("does not advance past the required error until user types a value", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<ManualCredentials onDone={onDone} />);

		// Skip the optional provider name, then empty Enter on API URL -> error
		stdin.write("\r");
		await tick();
		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").toContain("API URL is required");

		// Now type and Enter -> advances to API Key, error should clear
		stdin.write("https://x");
		await tick();
		stdin.write("\r");
		await tick();

		// Another empty Enter on API Key should show its own required error
		stdin.write("\r");
		await tick();
		expect(lastFrame() ?? "").toContain("API Key is required");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("readOnly ignores all keyboard input", async () => {
		const onDone = vi.fn();
		const { stdin, lastFrame } = render(
			<ManualCredentials onDone={onDone} readOnly={true} />,
		);

		stdin.write("hello");
		await tick();
		stdin.write("\r");
		await tick();

		expect(lastFrame() ?? "").not.toContain("hello");
		expect(onDone).not.toHaveBeenCalled();
	});
});
