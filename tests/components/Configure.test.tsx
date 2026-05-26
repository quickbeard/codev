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
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
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
	test("without shims, the message is the bare 'Done!'", async () => {
		const { frames } = render(
			<Configure
				tools={["opencode"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				shimsInstalled={false}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		expect(out).toContain("Done!");
		// Activation hint belongs to the shims-installed branches only —
		// negative pins because the shims branches still emit these.
		expect(out).not.toContain("exec $SHELL");
		expect(out).not.toContain("Restart your terminal");
	});

	test("with shims on Unix, the message is the exec-$SHELL hint", async () => {
		const text = await withPlatform("darwin", async () => {
			const { frames } = render(
				<Configure
					tools={["opencode"]}
					creds={{ apiKey: "sk-test", model: "m" }}
					shimsInstalled
					onDone={() => {}}
				/>,
			);
			await new Promise((r) => setTimeout(r, 30));
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
				<Configure
					tools={["opencode"]}
					creds={{ apiKey: "sk-test", model: "m" }}
					shimsInstalled
					onDone={() => {}}
				/>,
			);
			await new Promise((r) => setTimeout(r, 30));
			return lastFrame(frames);
		});
		expect(text).toContain("Done! Restart your terminal.");
		// Unix branch's Unix-only jargon must not leak across.
		expect(text).not.toMatch(/exec|\$SHELL/);
	});
});

describe("Configure dual-editor Continue", () => {
	test("dual-editor selection writes the shared Continue config once", async () => {
		// Both editor Tools map to the same `continue-config` BackupKind.
		// Configure's per-kind dedupe must emit a single `Configured Continue`
		// row rather than two.
		const { frames } = render(
			<Configure
				tools={["vscode-continue", "jetbrains-continue"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				shimsInstalled={false}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		const matches = out.match(/Configured Continue/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});
