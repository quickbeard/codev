import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	RESTORE_AGENTS,
	runRestore,
	runRestoreAll,
	toolForRestoreAgent,
} from "@/lib/restore.js";

let tempDir: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-restore-test-"));
	vi.stubEnv("HOME", tempDir);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempDir);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	logSpy.mockRestore();
	errorSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

function seedBackup(relFilePath: string, marker: string) {
	const livePath = join(tempDir, relFilePath);
	const backupPath = `${livePath}.backup`;
	mkdirSync(join(livePath, ".."), { recursive: true });
	writeFileSync(backupPath, JSON.stringify({ marker }));
	return { livePath, backupPath };
}

describe("runRestore", () => {
	test("restores Claude from backup and prints success", () => {
		const { livePath, backupPath } = seedBackup(
			".claude/settings.json",
			"claude-backup",
		);
		writeFileSync(livePath, '{"marker":"claude-live"}');

		const code = runRestore("claude-code");

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		const restored = JSON.parse(readFileSync(livePath, "utf-8"));
		expect(restored.marker).toBe("claude-backup");

		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Restored ") &&
					l.includes(livePath) &&
					l.includes(backupPath),
			),
		).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("restores OpenCode from backup and prints success", () => {
		const { livePath, backupPath } = seedBackup(
			".config/opencode/opencode.json",
			"opencode-backup",
		);

		const code = runRestore("opencode");

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);

		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Restored ") &&
					l.includes(livePath) &&
					l.includes(backupPath),
			),
		).toBe(true);
	});

	test("returns 1 and prints no-backup error for Claude", () => {
		const code = runRestore("claude-code");

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			errors.some(
				(e: string) =>
					e.startsWith("No backup found at") &&
					e.includes(join(tempDir, ".claude", "settings.json.backup")),
			),
		).toBe(true);
		expect(logSpy).not.toHaveBeenCalled();
	});

	test("returns 1 and prints no-backup error for OpenCode", () => {
		const code = runRestore("opencode");

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			errors.some(
				(e: string) =>
					e.startsWith("No backup found at") &&
					e.includes(
						join(tempDir, ".config", "opencode", "opencode.json.backup"),
					),
			),
		).toBe(true);
	});

	test("restores Codex from backup and prints success", () => {
		const { livePath, backupPath } = seedBackup(
			".codex/config.toml",
			"codex-backup",
		);

		const code = runRestore("codex");

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);

		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Restored ") &&
					l.includes(livePath) &&
					l.includes(backupPath),
			),
		).toBe(true);
	});

	test("returns 1 and prints no-backup error for Codex", () => {
		const code = runRestore("codex");

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			errors.some(
				(e: string) =>
					e.startsWith("No backup found at") &&
					e.includes(join(tempDir, ".codex", "config.toml.backup")),
			),
		).toBe(true);
	});

	test("restores VSCode/Continue from backup and prints success", () => {
		const { livePath, backupPath } = seedBackup(
			".continue/config.yaml",
			"continue-backup",
		);

		const code = runRestore("vscode-continue");

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);

		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Restored ") &&
					l.includes(livePath) &&
					l.includes(backupPath),
			),
		).toBe(true);
	});

	test("returns 1 and prints no-backup error for VSCode/Continue", () => {
		const code = runRestore("vscode-continue");

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			errors.some(
				(e: string) =>
					e.startsWith("No backup found at") &&
					e.includes(join(tempDir, ".continue", "config.yaml.backup")),
			),
		).toBe(true);
	});
});

describe("toolForRestoreAgent", () => {
	test("maps launch names to internal Tool names", () => {
		expect(toolForRestoreAgent("claude")).toBe("claude-code");
		expect(toolForRestoreAgent("codex")).toBe("codex");
		expect(toolForRestoreAgent("opencode")).toBe("opencode");
		expect(toolForRestoreAgent("vscode")).toBe("vscode-continue");
	});

	test("RESTORE_AGENTS exposes the launch names", () => {
		expect([...RESTORE_AGENTS]).toEqual([
			"claude",
			"codex",
			"opencode",
			"vscode",
		]);
	});
});

describe("runRestoreAll", () => {
	test("restores every tool that has a backup and skips the rest", () => {
		const claude = seedBackup(".claude/settings.json", "c");
		const opencode = seedBackup(".config/opencode/opencode.json", "o");
		// Codex intentionally has no backup — should be silently skipped.

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(existsSync(claude.backupPath)).toBe(false);
		expect(existsSync(opencode.backupPath)).toBe(false);
		// Two "Restored …" lines, no error output.
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs.filter((l: string) => l.startsWith("Restored "))).toHaveLength(
			2,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("returns 1 and prints a 'nothing to restore' error when no backups exist", () => {
		const code = runRestoreAll();

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(errors).toContain("No backups found. Nothing to restore.");
		expect(logSpy).not.toHaveBeenCalled();
	});

	test("does not surface a per-tool no-backup error for partial state", () => {
		// One tool with a backup, three without — restore the one, skip the rest
		// quietly. No "No backup found at …" lines (those belong to the
		// single-tool runRestore path).
		seedBackup(".claude/settings.json", "c");

		const code = runRestoreAll();

		expect(code).toBe(0);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(errors.some((e: string) => e.startsWith("No backup found at"))).toBe(
			false,
		);
	});

	test("sweeps the VSCode/Continue backup alongside the other agents", () => {
		const claude = seedBackup(".claude/settings.json", "c");
		const cont = seedBackup(".continue/config.yaml", "v");

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(existsSync(claude.backupPath)).toBe(false);
		expect(existsSync(cont.backupPath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs.filter((l: string) => l.startsWith("Restored "))).toHaveLength(
			2,
		);
	});
});
