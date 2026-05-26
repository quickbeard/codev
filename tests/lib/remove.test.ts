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
import { runRemove } from "@/lib/remove.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-remove-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
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
		".codev/auth.json",
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
	test("happy path: restores configs, removes shims, signs out, wipes ~/.codev", async () => {
		stubFetchOk();
		seedAuthSso();
		// Seed a shim and an rc-file sentinel block so uninstallShims has work to
		// do.
		seedFile(".codev/bin/claude", "#!/bin/sh\n");
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
		// SSO signed out (the auth file is part of ~/.codev which gets wiped).
		expect(existsSync(join(tempDir, ".codev"))).toBe(false);
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
		expect(existsSync(join(tempDir, ".claude/settings.json"))).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("ok");
		expect(claudeStep?.detail).toMatch(/no backup; deleted/);
	});

	test("no backup and no live config: reports nothing-to-restore as noop", async () => {
		stubFetchOk();

		const result = await runRemove();

		expect(result.anyFailed).toBe(false);
		const claudeStep = result.steps.find((s) => s.label.startsWith("Claude"));
		expect(claudeStep?.status).toBe("noop");
		expect(claudeStep?.detail).toBe("nothing to restore");
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

	test("~/.codev absent: cleanup step reported as noop", async () => {
		stubFetchOk();

		const result = await runRemove();

		const wipeStep = result.steps.find((s) => s.label === "~/.codev");
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
			return {
				status: "noop",
				sourcePath: `/tmp/${tool}-fake`,
				backupPath: `/tmp/${tool}-fake.backup`,
			};
		});

		const result = await runRemove();

		expect(result.anyFailed).toBe(true);
		const codexStep = result.steps.find((s) => s.label.startsWith("Codex"));
		expect(codexStep?.status).toBe("failed");
		expect(codexStep?.detail).toBe("boom");
		// Other steps still ran.
		expect(result.steps.find((s) => s.label === "~/.codev")).toBeDefined();
	});

	test("step order: SSO before Shims before configs before ~/.codev", async () => {
		stubFetchOk();
		const result = await runRemove();
		const order = result.steps.map((s) => s.label);
		expect(order[0]).toBe("SSO");
		expect(order[1]).toBe("Shims");
		expect(order.slice(2, 5).sort()).toEqual([
			"Claude Code config",
			"Codex config",
			"OpenCode config",
		]);
		expect(order[order.length - 1]).toBe("~/.codev");
	});
});
