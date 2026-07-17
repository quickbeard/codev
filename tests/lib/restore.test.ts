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
	configureClaudeCode,
	configureCodex,
	configureContinue,
	configureOpenCode,
} from "@/lib/configure.js";
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

// Write a genuine CoDev config by running the real writer. Deliberately not a
// hand-rolled marker literal: the authorship gate reads the same keys the
// writer emits, so a fake fixture would let the two drift apart silently — the
// gate would stop matching real configs while these tests kept passing.
// baseUrl is explicit so the writers don't fall back to AI_GATEWAY_URL(), which
// would need a seeded ~/.codev-hub/auth.json.
const CODEV_CREDS = {
	apiKey: "sk-test-key",
	baseUrl: "https://gw.test/gateway",
	model: "test-model",
};

// A config the user wrote themselves — no CoDev markers anywhere.
function seedUserConfig(relFilePath: string, contents: string) {
	const livePath = join(tempDir, relFilePath);
	mkdirSync(join(livePath, ".."), { recursive: true });
	writeFileSync(livePath, contents);
	return livePath;
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

	test("deletes the live CoDev config when no backup exists for Claude", () => {
		configureClaudeCode(CODEV_CREDS);
		const livePath = join(tempDir, ".claude", "settings.json");
		expect(existsSync(livePath)).toBe(true);

		const code = runRestore("claude-code");

		expect(code).toBe(0);
		// CoDev wrote it and no backup exists, so nothing preceded it — deleting
		// it *is* the pre-CoDev state.
		expect(existsSync(livePath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`Deleted ${livePath}; CoDev wrote it and no backup exists, so nothing preceded it.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("keeps a live user-written config when no backup exists for Claude", () => {
		const livePath = seedUserConfig(
			".claude/settings.json",
			'{"marker":"user-authored"}',
		);

		const code = runRestore("claude-code");

		expect(code).toBe(0);
		// No CoDev marker: this could be a config we never touched, or the
		// original a previous restore already reinstated. Either way, not ours.
		expect(existsSync(livePath)).toBe(true);
		expect(readFileSync(livePath, "utf-8")).toBe('{"marker":"user-authored"}');
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place (not written by CoDev).`,
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

	test("deletes the live CoDev config when no backup exists for OpenCode", () => {
		configureOpenCode(CODEV_CREDS);
		const livePath = join(tempDir, ".config", "opencode", "opencode.json");
		expect(existsSync(livePath)).toBe(true);

		const code = runRestore("opencode");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`Deleted ${livePath}; CoDev wrote it and no backup exists, so nothing preceded it.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("keeps a live user-written config when no backup exists for OpenCode", () => {
		const livePath = seedUserConfig(
			".config/opencode/opencode.json",
			'{"marker":"user-authored"}',
		);

		const code = runRestore("opencode");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place (not written by CoDev).`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("restores CoDev Code from backup and prints success", () => {
		const { livePath, backupPath } = seedBackup(
			".config/codev/codev.json",
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

	test("deletes the live CoDev config when no backup exists for Codex", () => {
		configureCodex(CODEV_CREDS);
		const livePath = join(tempDir, ".codex", "config.toml");
		expect(existsSync(livePath)).toBe(true);

		const code = runRestore("codex");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`Deleted ${livePath}; CoDev wrote it and no backup exists, so nothing preceded it.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("keeps a live user-written config when no backup exists for Codex", () => {
		const livePath = seedUserConfig(".codex/config.toml", 'model = "gpt-5"\n');

		const code = runRestore("codex");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		expect(readFileSync(livePath, "utf-8")).toBe('model = "gpt-5"\n');
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place (not written by CoDev).`,
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

	test("deletes the live CoDev config when no backup exists for VS Code/Continue", () => {
		configureContinue(CODEV_CREDS);
		const livePath = join(tempDir, ".continue", "config.yaml");
		expect(existsSync(livePath)).toBe(true);

		const code = runRestore("vscode-continue");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(false);
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`Deleted ${livePath}; CoDev wrote it and no backup exists, so nothing preceded it.`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("keeps a live user-written config when no backup exists for VS Code/Continue", () => {
		const livePath = seedUserConfig(
			".continue/config.yaml",
			'name: "my own assistant"\n',
		);

		const code = runRestore("vscode-continue");

		expect(code).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		expect(readFileSync(livePath, "utf-8")).toBe('name: "my own assistant"\n');
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs).toContain(
			`No backup at ${livePath}.backup; left ${livePath} in place (not written by CoDev).`,
		);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	// The gate's whole reason for existing: restore consumes the backup, so a
	// second run sees "no backup + live file" — and that live file is the user's
	// pristine original, which the first run just reinstated. Deleting it here
	// would destroy the very thing restore exists to bring back.
	test("running restore twice does not delete the reinstated original", () => {
		const livePath = join(tempDir, ".codex", "config.toml");
		mkdirSync(join(livePath, ".."), { recursive: true });
		writeFileSync(`${livePath}.backup`, 'model = "my-original"\n');
		configureCodex(CODEV_CREDS);

		expect(runRestore("codex")).toBe(0);
		expect(readFileSync(livePath, "utf-8")).toBe('model = "my-original"\n');

		expect(runRestore("codex")).toBe(0);
		expect(existsSync(livePath)).toBe(true);
		expect(readFileSync(livePath, "utf-8")).toBe('model = "my-original"\n');
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

	test("deletes backup-less CoDev configs and keeps backup-less user configs", () => {
		// One tool with a backup (restored), one with only a live CoDev config
		// (deleted), one with only a live user config (kept), the rest noop.
		const claude = seedBackup(".claude/settings.json", "c");
		configureOpenCode(CODEV_CREDS);
		const opencodeLive = join(tempDir, ".config", "opencode", "opencode.json");
		const codexLive = seedUserConfig(".codex/config.toml", 'model = "gpt-5"\n');

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(existsSync(claude.backupPath)).toBe(false);
		// CoDev wrote OpenCode's config and nothing preceded it → gone.
		expect(existsSync(opencodeLive)).toBe(false);
		// Codex was never configured by CoDev → the user's file survives.
		expect(existsSync(codexLive)).toBe(true);
		expect(readFileSync(codexLive, "utf-8")).toBe('model = "gpt-5"\n');
		const logs = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(logs.filter((l: string) => l.startsWith("Restored "))).toHaveLength(
			1,
		);
		expect(logs.filter((l: string) => l.startsWith("Deleted "))).toHaveLength(
			1,
		);
		expect(
			logs.filter((l: string) => l.startsWith("No backup at")),
		).toHaveLength(1);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	// A delete reverts the file to its pre-CoDev state just as a restore does,
	// so it has to count as action — otherwise a sweep that only had CoDev
	// configs to clean would wrongly exit 1 with "No backups found."
	test("a delete-only sweep counts as action and exits 0", () => {
		configureOpenCode(CODEV_CREDS);

		const code = runRestoreAll();

		expect(code).toBe(0);
		expect(
			existsSync(join(tempDir, ".config", "opencode", "opencode.json")),
		).toBe(false);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	// The mirror image: nothing was CoDev's, so nothing changed on disk. That is
	// still "nothing to restore", even though live files exist.
	test("a keep-only sweep changes nothing and exits 1", () => {
		seedUserConfig(".codex/config.toml", 'model = "gpt-5"\n');

		const code = runRestoreAll();

		expect(code).toBe(1);
		expect(existsSync(join(tempDir, ".codex", "config.toml"))).toBe(true);
		expect(errorSpy).toHaveBeenCalledWith(
			"No backups found. Nothing to restore.",
		);
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
