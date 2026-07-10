import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test } from "vitest";
import { SetupComplete } from "@/components/SetupComplete.js";

afterEach(() => {
	cleanup();
});

async function withPlatform<T>(
	value: NodeJS.Platform,
	fn: () => Promise<T>,
): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	try {
		return await fn();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
	}
}

function lastFrame(frames: string[]): string {
	return frames[frames.length - 1] ?? "";
}

describe("SetupComplete resume message", () => {
	test("without shims, the message is the bare 'Done!'", () => {
		const { lastFrame } = render(
			<SetupComplete tools={["opencode"]} shimsInstalled={false} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("Done!");
		// Activation hint belongs to the shims-installed branches only —
		// negative pins because the shims branches still emit these.
		expect(out).not.toContain("exec $SHELL");
		expect(out).not.toContain("Restart your terminal");
	});

	test("with shims on Unix, the message is the exec-$SHELL hint", async () => {
		const text = await withPlatform("darwin", async () => {
			const { frames } = render(
				<SetupComplete tools={["opencode"]} shimsInstalled={true} />,
			);
			return lastFrame(frames);
		});
		expect(text).toContain("Done! Run");
		expect(text).toContain("exec $SHELL");
		expect(text).toContain("to reload your shell.");
		// Windows branch's wording must not leak across.
		expect(text).not.toContain("Restart your terminal");
	});

	test("with shims on Windows, the message is the restart-terminal hint", async () => {
		const text = await withPlatform("win32", async () => {
			const { frames } = render(
				<SetupComplete tools={["opencode"]} shimsInstalled={true} />,
			);
			return lastFrame(frames);
		});
		expect(text).toContain("Done! Restart your terminal.");
		// Unix branch's Unix-only jargon must not leak across.
		expect(text).not.toMatch(/exec|\$SHELL/);
	});

	test("with no tools selected, no Done line renders", () => {
		const { lastFrame } = render(
			<SetupComplete tools={[]} shimsInstalled={true} />,
		);
		const out = lastFrame() ?? "";
		// Tools-empty short-circuit suppresses the resume line; the HELP_HINT
		// and HAPPY_CODING still render but no "Done!" message appears.
		expect(out).not.toContain("Done!");
	});

	test("HELP_HINT and HAPPY_CODING always render", () => {
		const { lastFrame } = render(
			<SetupComplete tools={["codex"]} shimsInstalled={true} />,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("codevhub --help");
		expect(out).toContain("Happy coding");
	});
});
