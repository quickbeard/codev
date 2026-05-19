import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Configure } from "@/components/Configure.js";

let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "codev-configure-test-"));
	vi.stubEnv("HOME", tempHome);
});

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
});

async function withPlatform<T>(
	value: NodeJS.Platform,
	fn: () => Promise<T>,
): Promise<T> {
	// Keep process.platform stubbed across awaits — Configure's resume message
	// reads it during the post-useEffect re-render, not during the first render.
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

describe("Configure resume message", () => {
	test("without shims, falls back to the plain 'You can now run' phrasing", async () => {
		const { frames } = render(
			<Configure
				tools={["opencode"]}
				creds={{ apiKey: "sk-test" }}
				shimsInstalled={false}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		expect(out).toContain("Done! You can now run");
		expect(out).toContain("codev opencode");
		expect(out).toContain("to get started.");
		// Activation hint must not appear when shims weren't installed.
		expect(out).not.toContain("exec $SHELL");
		expect(out).not.toContain("Restart your terminal");
	});

	test("with shims on Unix, merges `exec $SHELL` into the Done sentence", async () => {
		const text = await withPlatform("darwin", async () => {
			const { frames } = render(
				<Configure
					tools={["opencode"]}
					creds={{ apiKey: "sk-test" }}
					shimsInstalled
					onDone={() => {}}
				/>,
			);
			await new Promise((r) => setTimeout(r, 30));
			return lastFrame(frames);
		});
		expect(text).toContain("Done! Run");
		expect(text).toContain("exec $SHELL");
		expect(text).toContain("to activate, then");
		expect(text).toContain("opencode");
		expect(text).toContain("to get started.");
		// With shims, the bare binary name is what users invoke — the
		// `codev <agent>` form is reserved for the no-shims fallback branch.
		expect(text).not.toContain("codev opencode");
		// The old two-sentence form should be gone.
		expect(text).not.toContain("You can now run");
	});

	test("with shims on Windows, merges 'Restart your terminal' into the Done sentence", async () => {
		const text = await withPlatform("win32", async () => {
			const { frames } = render(
				<Configure
					tools={["opencode"]}
					creds={{ apiKey: "sk-test" }}
					shimsInstalled
					onDone={() => {}}
				/>,
			);
			await new Promise((r) => setTimeout(r, 30));
			return lastFrame(frames);
		});
		expect(text).toContain("Done! Restart your terminal, then run");
		expect(text).toContain("opencode");
		expect(text).toContain("to get started.");
		expect(text).not.toContain("codev opencode");
		// Windows must not mention Unix-only jargon.
		expect(text).not.toMatch(/exec|\$SHELL/);
	});

	test("with multiple tools, joins them with 'or' and keeps the merged activation hint", async () => {
		const text = await withPlatform("darwin", async () => {
			const { frames } = render(
				<Configure
					tools={["claude-code", "opencode"]}
					creds={{ apiKey: "sk-test" }}
					shimsInstalled
					onDone={() => {}}
				/>,
			);
			await new Promise((r) => setTimeout(r, 30));
			return lastFrame(frames);
		});
		expect(text).toContain("exec $SHELL");
		expect(text).toContain("claude");
		expect(text).toContain(" or ");
		expect(text).toContain("opencode");
		expect(text).not.toContain("codev claude");
		expect(text).not.toContain("codev opencode");
	});
});
