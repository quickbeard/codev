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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as codegraph from "@/lib/codegraph.js";
import { runRemove } from "@/lib/remove.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-remove-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	// The CodeGraph uninstall step shells out to the `codegraph` CLI. Default it
	// to a clean success so the remove tests never spawn the real binary (which
	// would edit the developer's actual agent configs); specific tests override.
	vi.spyOn(codegraph, "runCodegraphUninstall").mockResolvedValue(null);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

function seedFile(rel: string, body: string) {
	const p = join(tempDir, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, body);
	return p;
}

function seedAuthSso() {
	// Minimal auth.json with an access_token — gives logout() something to
	// revoke. The revoke fetch is best-effort; we stub global fetch to avoid
	// real network from the test.
	seedFile(
		".codev-hub/auth.json",
		JSON.stringify({
			access_token: "tok",
			id_token: "id",
			expires_at: Date.now() + 3_600_000,
			user: { sub: "u", email: "e@example.com", displayName: "U" },
		}),
	);
}

function stubFetchOk() {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
}

describe("runRemove", () => {
	test("happy path: restores configs, removes shims, signs out, wipes ~/.codev-hub", async () => {
		stubFetchOk();
		seedAuthSso();
		// Seed a shim and an rc-file sentinel block so uninstallShims has work to
		// do.
		seedFile(".codev-hub/bin/claude", "#!/bin/sh\n");
		seedFile(
			".zshrc",
			`existing\n# >>> codev shims (managed) >>>\nalias claude="..."\n# <<< codev shims (managed) <<<\n`,
		);
		// Seed backups for all three tools so the restore branch fires.
		seedFile(".claude/settings.json", '{"live":true}');
		seedFile(".claude/settings.json.backup", '{"original":"claude"}');
		seedFile(".codex/config.toml", "live = true\n");
		seedFile(".codex/config.toml.backup", 'original = "codex"\n');
		seedFile(".config/opencode/opencode.json", '{"live":true}');
		seedFile(
			".config/opencode/opencode.json.backup",
			'{"original":"opencode"}',
		);

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		// SSO signed out (the auth file is part of ~/.codev-hub which gets wiped).
		expect(existsSync(join(tempDir, ".codev-hub"))).toBe(false);
		// Backups renamed over live configs.
		expect(
			JSON.parse(readFileSync(join(tempDir, ".claude/settings.json"), "utf-8")),
		).toEqual({ original: "claude" });
		expect(
			readFileSync(join(tempDir, ".codex/config.toml"), "utf-8"),
		).toContain("codex");
		expect(
			JSON.parse(
				readFileSync(join(tempDir, ".config/opencode/opencode.json"), "utf-8"),
			),
		).toEqual({ original: "opencode" });
		// Sentinel block stripped from .zshrc. On Windows, uninstallShims
		// patches the PowerShell profile instead — the .zshrc cleanup is the
		// POSIX-only contract; check the PS profile (if it was seeded) on
		// Windows.
		if (process.platform !== "win32") {
			expect(readFileSync(join(tempDir, ".zshrc"), "utf-8")).not.toContain(
				"codev shims (managed)",
			);
		}
	});

	test("no backup but live config exists: deletes live config", async () => {
		stubFetchOk();
		seedFile(".claude/settings.json", '{"codev":"wrote-this"}');

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		// No backup to restore from, so "no file" is the pre-CoDev state.
		expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("ok");
		// Claude restore aggregates three files: settings.json is deleted-live
		// (no backup), the other two are noop (neither live nor backup).
		expect(claudeStep?.detail).toMatch(/deleted 1 file \(no backup\)/);
		expect(claudeStep?.detail).toMatch(/2 already clean/);
	});

	test("deletes ~/.claude.json and .credentials.json when they have no backup", async () => {
		stubFetchOk();
		// Both are Claude-owned files that restoreTool sweeps alongside
		// settings.json. `remove` means "leave no CoDev environment behind", so a
		// backup-less one goes even though it may hold a post-install login or
		// Claude's own project history.
		seedFile(".claude.json", '{"hasCompletedOnboarding":true,"projects":{}}');
		seedFile(
			".claude/.credentials.json",
			'{"claudeAiOauth":{"accessToken":"t"}}',
		);
		seedFile(".claude/settings.json", '{"codev":"wrote-this"}');

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude/.credentials.json"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.detail).toMatch(/deleted 3 files \(no backup\)/);
	});

	test("no backup and no live config: reports nothing-to-restore as noop", async () => {
		stubFetchOk();

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("noop");
		expect(claudeStep?.detail).toBe("nothing to restore");
	});

	test("CoDev Code config: restores from backup when one exists", async () => {
		stubFetchOk();
		// The fork's gateway config lives at ~/.config/codev/codev.json
		// (distinct from OpenCode's ~/.config/opencode/opencode.json).
		seedFile(".config/codev/codev.json", '{"live":true}');
		seedFile(".config/codev/codev.json.backup", '{"original":"codev-code"}');

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		// Backup renamed over the live config — the user's pre-CoDev state.
		expect(
			JSON.parse(
				readFileSync(join(tempDir, ".config/codev/codev.json"), "utf-8"),
			),
		).toEqual({ original: "codev-code" });
		// The rename consumes the backup, so it no longer sits alongside.
		expect(existsSync(join(tempDir, ".config/codev/codev.json.backup"))).toBe(
			false,
		);
		const step = result.steps.find((s) => s.label === "CoDev Code config");
		expect(step?.status).toBe("ok");
		expect(step?.detail).toContain("restored from");
	});

	test("CoDev Code config: deletes the live config when no backup exists", async () => {
		stubFetchOk();
		// A fresh install writes this with no prior user config, so there's no
		// backup — deleting it lands the user back at "no file", the pre-CoDev
		// state.
		seedFile(".config/codev/codev.json", '{"codev":"wrote-this"}');

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		expect(existsSync(join(tempDir, ".config/codev/codev.json"))).toBe(false);
		const step = result.steps.find((s) => s.label === "CoDev Code config");
		expect(step?.status).toBe("ok");
		expect(step?.detail).toContain("no backup; deleted");
	});

	test("not signed in: SSO step reported as noop, not failed", async () => {
		stubFetchOk();
		// No auth.json seeded — logout() returns false.

		const result = await runRemove();

		const ssoStep = result.steps.find((s) => s.label === "SSO");
		expect(ssoStep?.status).toBe("noop");
		expect(ssoStep?.detail).toBe("not signed in");
		expect(result.anyFailed).toBe(false);
	});

	test("~/.codev-hub absent: cleanup step reported as noop", async () => {
		stubFetchOk();

		const result = await runRemove();

		const wipeStep = result.steps.find((s) => s.label === "~/.codev-hub");
		expect(wipeStep?.status).toBe("noop");
		expect(wipeStep?.detail).toBe("already absent");
	});

	test("anyFailed=true when restore throws", async () => {
		stubFetchOk();
		const configure = await import("@/lib/configure.js");
		// Throw only for codex so the other steps still run; this proves
		// best-effort behavior.
		vi.spyOn(configure, "restoreTool").mockImplementation((tool) => {
			if (tool === "codex") throw new Error("boom");
			return [
				{
					status: "noop",
					sourcePath: `/tmp/${tool}-fake`,
					backupPath: `/tmp/${tool}-fake.backup`,
				},
			];
		});

		const result = await runRemove();

		expect(result.anyFailed).toBe(true);
		const codexStep = result.steps.find((s) => s.label.startsWith("Codex"));
		expect(codexStep?.status).toBe("failed");
		expect(codexStep?.detail).toBe("boom");
		// Other steps still ran.
		expect(result.steps.find((s) => s.label === "~/.codev-hub")).toBeDefined();
	});

	test("step order: SSO, Shims, CodeGraph, configs, then ~/.codev-hub", async () => {
		stubFetchOk();
		const result = await runRemove();
		const order = result.steps.map((s) => s.label);
		expect(order[0]).toBe("SSO");
		expect(order[1]).toBe("Shims");
		expect(order[2]).toBe("CodeGraph");
		// The five config tools (one per BackupKind) sit between CodeGraph and the
		// ~/.codev-hub wipe — CoDev Code and Continue included.
		expect(order.slice(3, 8).sort()).toEqual([
			"Claude Code config",
			"CoDev Code config",
			"Codex config",
			"Continue config",
			"OpenCode config",
		]);
		expect(order[order.length - 1]).toBe("~/.codev-hub");
	});

	test("codegraph: removes MCP wiring from agents (ok step)", async () => {
		stubFetchOk();
		const result = await runRemove();
		const cg = result.steps.find((s) => s.label === "CodeGraph");
		expect(cg?.status).toBe("ok");
		expect(result.anyFailed).toBe(false);
	});

	test("codegraph: an uninstall error warns but does NOT fail the remove", async () => {
		stubFetchOk();
		// Simulate the codegraph package having been removed already.
		vi.mocked(codegraph.runCodegraphUninstall).mockResolvedValue(
			"spawn codegraph ENOENT",
		);
		const result = await runRemove();
		const cg = result.steps.find((s) => s.label === "CodeGraph");
		expect(cg?.status).toBe("warning");
		expect(cg?.detail).toContain("ENOENT");
		// Non-fatal: the overall remove still succeeds.
		expect(result.anyFailed).toBe(false);
	});
});
