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
import { configureClaudeCode, configureCodevCode } from "@/lib/configure.js";
import { runRemove } from "@/lib/remove.js";

// Seeds a genuine CoDev config via the real writer, so the authorship gate is
// tested against the keys the writer actually emits rather than a hand-rolled
// marker that could silently drift. baseUrl is explicit to avoid the
// AI_GATEWAY_URL() fallback, which would need gateway_url in auth.json.
const CODEV_CREDS = {
	apiKey: "sk-test-key",
	baseUrl: "https://gw.test/gateway",
	model: "test-model",
};

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-remove-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	// The credential scrub resolves CoDev Code's data dir via XDG_DATA_HOME
	// before falling back to $HOME/.local/share; clear it so a host that
	// exports it can't leak test writes into a real data dir.
	vi.stubEnv("XDG_DATA_HOME", "");
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

	test("no backup but live CoDev config exists: deletes it", async () => {
		stubFetchOk();
		configureClaudeCode(CODEV_CREDS);

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		// CoDev wrote it and no backup exists, so nothing preceded it.
		expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("ok");
		// Claude restore aggregates three files: settings.json is deleted, the
		// other two are noop (neither live nor backup).
		expect(claudeStep?.detail).toMatch(/deleted 1 file \(no backup\)/);
		expect(claudeStep?.detail).toMatch(/2 already clean/);
		// Nothing left for the user to clean up by hand.
		expect(result.keptPaths).toEqual([]);
	});

	test("no backup but live user config exists: keeps it", async () => {
		stubFetchOk();
		seedFile(".claude/settings.json", '{"marker":"user-authored"}');

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		// No CoDev marker, so it isn't ours to delete.
		expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(true);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("ok");
		expect(claudeStep?.detail).toMatch(/kept 1 of your file/);
		expect(claudeStep?.detail).toMatch(/2 already clean/);
		// The kept file is surfaced for the user-facing hint.
		expect(result.keptPaths).toContain(join(tempDir, ".claude/settings.json"));
	});

	test("force: deletes a live user config the gate would otherwise keep", async () => {
		stubFetchOk();
		seedFile(".claude/settings.json", '{"marker":"user-authored"}');

		const result = await runRemove(true);

		expect(result.anyFailed).toBe(false);
		expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("ok");
		// Reported as forced, so the count doesn't imply the file was CoDev's.
		expect(claudeStep?.detail).toMatch(
			/deleted 1 file \(no backup, 1 forced\)/,
		);
		// Nothing was preserved, so there's nothing to list as kept.
		expect(result.keptPaths).toEqual([]);
	});

	test("force: still restores from a backup instead of deleting", async () => {
		stubFetchOk();
		seedFile(".config/codev/codev.json", '{"live":true}');
		seedFile(".config/codev/codev.json.backup", '{"original":"codev-code"}');

		const result = await runRemove(true);

		expect(result.anyFailed).toBe(false);
		// force skips the authorship gate, never the backup branch.
		expect(
			JSON.parse(
				readFileSync(join(tempDir, ".config/codev/codev.json"), "utf-8"),
			),
		).toEqual({ original: "codev-code" });
		const step = result.steps.find((s) => s.label === "CoDev Code config");
		expect(step?.detail).toContain("restored from");
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

	test("CoDev Code config: deletes the live CoDev config when no backup exists", async () => {
		stubFetchOk();
		// A fresh install writes this with no prior user config, so there's no
		// backup — nothing preceded it, so remove takes it back out.
		configureCodevCode(CODEV_CREDS);
		expect(existsSync(join(tempDir, ".config/codev/codev.json"))).toBe(true);

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		expect(existsSync(join(tempDir, ".config/codev/codev.json"))).toBe(false);
		const step = result.steps.find((s) => s.label === "CoDev Code config");
		expect(step?.status).toBe("ok");
		expect(step?.detail).toContain("no backup; deleted CoDev's");
		expect(result.keptPaths).toEqual([]);
	});

	test("CoDev Code config: keeps a live user config when no backup exists", async () => {
		stubFetchOk();
		// The user hand-wrote this and never ran it through CoDev, so remove has
		// no business deleting it.
		seedFile(".config/codev/codev.json", '{"marker":"user-authored"}');

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		expect(existsSync(join(tempDir, ".config/codev/codev.json"))).toBe(true);
		const step = result.steps.find((s) => s.label === "CoDev Code config");
		expect(step?.status).toBe("ok");
		expect(step?.detail).toContain("no backup; kept your");
		expect(result.keptPaths).toContain(
			join(tempDir, ".config/codev/codev.json"),
		);
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

	test("codegraph: sweeps the CoDev Code mcp entry from a user-owned config it keeps", async () => {
		stubFetchOk();
		// A codev.json the user wrote themselves (no CoDev marker, no backup),
		// wired with the CodeGraph entry plus a server of their own. Remove must
		// strip exactly the CodeGraph entry — matching `codegraph uninstall`
		// semantics on every other agent's config — while the authorship gate
		// keeps the file itself.
		const filePath = seedFile(
			".config/codev/codev.json",
			JSON.stringify(
				{
					theme: "dark",
					mcp: {
						codegraph: {
							type: "local",
							command: ["codegraph", "serve", "--mcp"],
							enabled: true,
						},
						mine: { type: "local", command: ["mine"], enabled: true },
					},
				},
				null,
				2,
			),
		);
		const result = await runRemove();
		const cg = result.steps.find((s) => s.label === "CodeGraph");
		expect(cg?.status).toBe("ok");
		// The file survives (kept-live) minus the CodeGraph entry.
		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.theme).toBe("dark");
		expect(config.mcp.codegraph).toBeUndefined();
		expect(config.mcp.mine.command).toEqual(["mine"]);
		expect(result.keptPaths).toContain(filePath);
	});
});

describe("CoDev Code credential scrub", () => {
	test("removes the configure-written auth entry, keeping user-connected ones", async () => {
		stubFetchOk();
		configureCodevCode(CODEV_CREDS);
		const authPath = join(tempDir, ".local", "share", "codev", "auth.json");
		// A provider the user connected inside the agent must survive the remove.
		writeFileSync(
			authPath,
			JSON.stringify({
				...JSON.parse(readFileSync(authPath, "utf-8")),
				anthropic: { type: "api", key: "sk-user" },
			}),
		);

		const result = await runRemove();

		const step = result.steps.find((s) => s.label === "CoDev Code credential");
		expect(step?.status).toBe("ok");
		expect(step?.detail).toContain("netgate");
		const auth = JSON.parse(readFileSync(authPath, "utf-8"));
		expect(auth).toEqual({ anthropic: { type: "api", key: "sk-user" } });
	});

	test("reports noop when no CoDev entry is stored", async () => {
		stubFetchOk();
		const result = await runRemove();
		const step = result.steps.find((s) => s.label === "CoDev Code credential");
		expect(step?.status).toBe("noop");
	});
});
