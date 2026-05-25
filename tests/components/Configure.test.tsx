import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Configure } from "@/components/Configure.js";
import { JETBRAINS_HINT, VSCODE_HINT } from "@/components/Install.js";

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
	test("without shims, falls back to the plain 'You can now run' phrasing", async () => {
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
					creds={{ apiKey: "sk-test", model: "m" }}
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
					creds={{ apiKey: "sk-test", model: "m" }}
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

	test("JetBrains entry renders as plain text, not a shell command", async () => {
		// `your JetBrains IDE` is descriptive prose, not a literal command to
		// type — keep it out of the cyan code-block styling reserved for
		// real shell invocations like `claude` / `code` / `exec $SHELL`.
		const { frames } = render(
			<Configure
				tools={["jetbrains-continue"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				shimsInstalled={false}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		expect(out).toContain("your JetBrains IDE");
		expect(out).toContain("to get started.");
	});
});

describe("Configure soft-fail install warnings", () => {
	test("renders the manual-install hint when a vscode-continue warning is plumbed in", async () => {
		const { frames } = render(
			<Configure
				tools={["vscode-continue"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				shimsInstalled={false}
				installWarnings={[
					{
						tool: "vscode-continue",
						message: "VS Code launcher not found on PATH",
					},
				]}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		// Ink wraps long lines; normalize whitespace before substring-matching
		// so wrap points don't break the assertion.
		const out = lastFrame(frames).replace(/\s+/g, " ");
		expect(out).toContain("Continue extension auto-install did not complete");
		expect(out).toContain("VS Code launcher not found on PATH");
		// Shared with the install row (Install.tsx's VSCODE_HINT). Reword
		// either the constant or this rendering and a different test fails —
		// the single source of truth is the export from Install.tsx.
		expect(out).toContain(VSCODE_HINT);
		expect(out).toContain("code --install-extension continue.continue");
	});

	test("renders the manual-install hint when a jetbrains-continue warning is plumbed in", async () => {
		const { frames } = render(
			<Configure
				tools={["jetbrains-continue"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				shimsInstalled={false}
				installWarnings={[
					{
						tool: "jetbrains-continue",
						message:
							"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
					},
				]}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		// Ink wraps long lines inside the rendered frame, so the warning text
		// can be split across multiple physical rows. Normalize whitespace
		// before substring-matching so the assertion stays robust to wrapping.
		const out = lastFrame(frames).replace(/\s+/g, " ");
		expect(out).toContain("Continue plugin auto-install did not complete");
		expect(out).toContain(
			"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
		);
		expect(out).toContain(JETBRAINS_HINT);
		expect(out).toContain("installPlugins");
		expect(out).toContain("com.github.continuedev.continueintellijextension");
	});

	test("no warning props → no hint rendered", async () => {
		// Successful auto-install path: install reported null, so no warning
		// rides forward. Configure must not invent a hint of its own.
		const { frames } = render(
			<Configure
				tools={["vscode-continue"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				shimsInstalled={false}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		expect(out).not.toContain("auto-install did not complete");
		expect(out).not.toContain(VSCODE_HINT);
	});

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
