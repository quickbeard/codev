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

	test("keeps the live CoDev config when no backup exists for Claude", () => {
		const livePath = join(tempDir, ".claude", "settings.json");
		mkdirSync(join(livePath, ".."), { recursive: true });
		writeFileSync(livePath, '{"marker":"codev-live"}');

		const code = runRestore("claude-code");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("is a noop when neither backup nor live config exists for Claude", () => {
		const code = runRestore("claude-code");

		expect(code).toBe(0);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.some(
				(l: string) =>
					l.startsWith("Nothing to restore for") &&
					l.includes(join(tempDir, ".claude", "settings.json")) &&
					l.includes("already at pre-CoDev state"),
			),
		).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("keeps the live CoDev config when no backup exists for OpenCode", () => {
		const livePath = join(tempDir, ".config", "opencode", "opencode.json");
		mkdirSync(join(livePath, ".."), { recursive: true });
		writeFileSync(livePath, '{"marker":"codev-live"}');

		const code = runRestore("opencode");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("restores CoDev Code from backup and prints success", () => {
		const { livePath, backupPath } = seedBackup(
			".config/codev-code/opencode.json",
			"codev-code-backup",
		);

		const code = runRestore("codev-code");

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

	test("keeps the live CoDev config when no backup exists for Codex", () => {
		const livePath = join(tempDir, ".codex", "config.toml");
		mkdirSync(join(livePath, ".."), { recursive: true });
		writeFileSync(livePath, 'marker = "codev-live"\n');

		const code = runRestore("codex");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("restores VS Code/Continue from backup and prints success", () => {
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

	test("keeps the live CoDev config when no backup exists for VS Code/Continue", () => {
		const livePath = join(tempDir, ".continue", "config.yaml");
		mkdirSync(join(livePath, ".."), { recursive: true });
		writeFileSync(livePath, 'name: "codev-live"\n');

		const code = runRestore("vscode-continue");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});
});

describe("toolForRestoreAgent", () => {
	test("maps launch names to internal Tool names", () => {
		expect(toolForRestoreAgent("claude")).toBe("claude-code");
		expect(toolForRestoreAgent("codex")).toBe("codex");
		expect(toolForRestoreAgent("opencode")).toBe("opencode");
		expect(toolForRestoreAgent("codev")).toBe("codev-code");
		// One editor-neutral alias for the shared Continue config — `continue`
		// routes to `vscode-continue` canonically; the backup file is shared
		// between VS Code and JetBrains, so either editor Tool would have done.
		expect(toolForRestoreAgent("continue")).toBe("vscode-continue");
	});

	test("RESTORE_AGENTS exposes the launch names", () => {
		expect([...RESTORE_AGENTS]).toEqual([
			"claude",
			"codex",
			"opencode",
			"codev",
			"continue",
		]);
	});
});

describe("runRestoreAll", () => {
	test("restores every tool that has a backup and reports noop for the rest", () => {
		const claude = seedBackup(".claude/settings.json", "c");
		const opencode = seedBackup(".config/opencode/opencode.json", "o");
		// Codex, CoDev Code, and Continue intentionally have neither backup nor
		// live file — each should report a "Nothing to restore for …" line. The
		// Claude sweep additionally noops on ~/.claude.json and
		// ~/.claude/.credentials.json since only settings.json was seeded.

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(existsSync(claude.backupPath)).toBe(false);
		expect(existsSync(opencode.backupPath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs.filter((l: string) => l.startsWith("Restored "))).toHaveLength(
			2,
		);
		// 5 noops: 2 from the unsequenced Claude files + Codex + CoDev Code +
		// Continue.
		expect(
			logs.filter((l: string) => l.startsWith("Nothing to restore for ")),
		).toHaveLength(5);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("returns 1 and prints a 'nothing to restore' error when every tool is a noop", () => {
		const code = runRestoreAll();

		expect(code).toBe(1);
		const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(errors).toContain("No backups found. Nothing to restore.");
		// Seven per-file noop lines: Claude contributes 3 (settings.json,
		// .claude.json, .credentials.json) + Codex + OpenCode + CoDev Code +
		// Continue.
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			logs.filter((l: string) => l.startsWith("Nothing to restore for ")),
		).toHaveLength(7);
	});

	test("keeps live CoDev configs for tools without a backup", () => {
		// One tool with a backup, one with only a live CoDev config, two with
		// neither. The sweep should restore the first, keep the second in place,
		// noop the rest.
		const claude = seedBackup(".claude/settings.json", "c");
		const opencodeLive = join(tempDir, ".config", "opencode", "opencode.json");
		mkdirSync(join(opencodeLive, ".."), { recursive: true });
		writeFileSync(opencodeLive, '{"marker":"codev-live"}');

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(existsSync(claude.backupPath)).toBe(false);
		// No backup for OpenCode, so its live config is left untouched.
		expect(existsSync(opencodeLive)).toBe(true);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs.filter((l: string) => l.startsWith("Restored "))).toHaveLength(
			1,
		);
		expect(
			logs.filter((l: string) => l.startsWith("No backup at")),
		).toHaveLength(1);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("sweeps the Continue backup alongside the other agents", () => {
		const claude = seedBackup(".claude/settings.json", "c");
		const cont = seedBackup(".continue/config.yaml", "v");

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(existsSync(claude.backupPath)).toBe(false);
		expect(existsSync(cont.backupPath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		// The sweep iterates one Tool per BackupKind (the deduped 4-tool list),
		// so Continue's shared `~/.continue/config.yaml.backup` is restored
		// exactly once under the canonical `vscode-continue` entry.
		expect(logs.filter((l: string) => l.startsWith("Restored "))).toHaveLength(
			2,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("the `continue` alias rolls back the shared Continue file", () => {
		// One alias for both editors — `codevhub restore continue` rolls back
		// ~/.continue/config.yaml regardless of which editor (or both) the
		// user actually has installed.
		const { livePath, backupPath } = seedBackup(
			".continue/config.yaml",
			"continue-backup",
		);

		const code = runRestore(toolForRestoreAgent("continue"));

		expect(code).toBe(0);
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
	});
});
