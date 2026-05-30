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

function lastFrame(frames: string[]): string {
	return frames[frames.length - 1] ?? "";
}

describe("Configure dual-editor Continue", () => {
	test("dual-editor selection writes the shared Continue config once", async () => {
		// Both editor Tools map to the same `continue-config` BackupKind.
		// Configure's per-kind dedupe must emit a single `Configured Continue`
		// row rather than two.
		const { frames } = render(
			<Configure
				tools={["vscode-continue", "jetbrains-continue"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		const matches = out.match(/Configured Continue/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});

describe("Configure Claude Code CLI + extension dedup", () => {
	test("CLI + both extension variants together write the shared Claude Code config once", async () => {
		// All three Tools map to the same `claude-settings` BackupKind, so
		// `~/.claude/settings.json` should be written exactly once and the
		// resume log should carry a single `Configured Claude Code` row —
		// not three.
		const { frames } = render(
			<Configure
				tools={["claude-code", "vscode-claude-code", "jetbrains-claude-code"]}
				creds={{ apiKey: "sk-test", model: "m" }}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		const out = lastFrame(frames);
		const matches = out.match(/Configured Claude Code/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});
