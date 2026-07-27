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
import TOML from "@iarna/toml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AI_GATEWAY_OPENAI_URL, AI_GATEWAY_URL } from "@/lib/const.js";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-test-"));
	vi.stubEnv("HOME", tempDir);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempDir);
	// The configure* functions fall back to AI_GATEWAY_URL()/AI_GATEWAY_OPENAI_URL()
	// whenever creds carry no baseUrl (the SSO-key path), and those accessors read
	// gateway_url out of ~/.codev-hub/auth.json. Seed it so the fallback resolves.
	const codevDir = join(tempDir, ".codev-hub");
	mkdirSync(codevDir, { recursive: true });
	writeFileSync(
		join(codevDir, "auth.json"),
		JSON.stringify({ gateway_url: "https://gw.test/gateway" }),
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("resetClaudeAuth", () => {
	test("creates .claude.json with hasCompletedOnboarding when file does not exist", async () => {
		const { resetClaudeAuth } = await import("@/lib/configure.js");
		const results = resetClaudeAuth();

		const filePath = join(tempDir, ".claude.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual({ hasCompletedOnboarding: true });

		const jsonResult = results.find((r) => r.kind === "claude-json");
		expect(jsonResult?.backupPath).toBeNull();
		expect(jsonResult?.created).toBe(false);
	});

	test("backs up an existing .claude.json then overwrites it with the bypass blob", async () => {
		const filePath = join(tempDir, ".claude.json");
		const backupPath = `${filePath}.backup`;
		const original = { someKey: "someValue", nested: { x: 1 } };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { resetClaudeAuth } = await import("@/lib/configure.js");
		const results = resetClaudeAuth();

		// Backup carries the user's original contents verbatim.
		expect(existsSync(backupPath)).toBe(true);
		expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual(original);

		// Live file is replaced — pre-existing fields are NOT preserved.
		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual({ hasCompletedOnboarding: true });

		const jsonResult = results.find((r) => r.kind === "claude-json");
		expect(jsonResult?.backupPath).toBe(backupPath);
		expect(jsonResult?.created).toBe(true);
	});

	test("preserves a pre-existing .claude.json.backup across repeated runs", async () => {
		const filePath = join(tempDir, ".claude.json");
		const backupPath = `${filePath}.backup`;
		writeFileSync(backupPath, JSON.stringify({ marker: "original" }));
		writeFileSync(filePath, JSON.stringify({ marker: "prev-codev-run" }));

		const { resetClaudeAuth } = await import("@/lib/configure.js");
		resetClaudeAuth();

		expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual({
			marker: "original",
		});
	});

	test("backs up and removes ~/.claude/.credentials.json", async () => {
		const dir = join(tempDir, ".claude");
		const credPath = join(dir, ".credentials.json");
		const credBackup = `${credPath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(credPath, JSON.stringify({ session: "user-session" }));

		const { resetClaudeAuth } = await import("@/lib/configure.js");
		const results = resetClaudeAuth();

		expect(existsSync(credPath)).toBe(false);
		expect(existsSync(credBackup)).toBe(true);
		expect(JSON.parse(readFileSync(credBackup, "utf-8"))).toEqual({
			session: "user-session",
		});

		const credResult = results.find((r) => r.kind === "claude-credentials");
		expect(credResult?.backupPath).toBe(credBackup);
		expect(credResult?.created).toBe(true);
	});

	test("noop on .credentials.json when neither live nor backup exists", async () => {
		const credPath = join(tempDir, ".claude", ".credentials.json");

		const { resetClaudeAuth } = await import("@/lib/configure.js");
		const results = resetClaudeAuth();

		expect(existsSync(credPath)).toBe(false);
		expect(existsSync(`${credPath}.backup`)).toBe(false);

		const credResult = results.find((r) => r.kind === "claude-credentials");
		expect(credResult?.backupPath).toBeNull();
		expect(credResult?.created).toBe(false);
	});

	test("preserves a pre-existing .credentials.json.backup", async () => {
		const dir = join(tempDir, ".claude");
		const credPath = join(dir, ".credentials.json");
		const credBackup = `${credPath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(credBackup, JSON.stringify({ session: "original" }));
		writeFileSync(credPath, JSON.stringify({ session: "newer-session" }));

		const { resetClaudeAuth } = await import("@/lib/configure.js");
		resetClaudeAuth();

		// Original backup not clobbered; live file still removed.
		expect(JSON.parse(readFileSync(credBackup, "utf-8"))).toEqual({
			session: "original",
		});
		expect(existsSync(credPath)).toBe(false);
	});
});

describe("backupClaudeAuth", () => {
	test("backs up an existing .claude.json and leaves the original intact", async () => {
		const filePath = join(tempDir, ".claude.json");
		const backupPath = `${filePath}.backup`;
		const original = { someKey: "someValue", nested: { x: 1 } };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { backupClaudeAuth } = await import("@/lib/configure.js");
		const results = backupClaudeAuth();

		// Backup carries the user's original contents.
		expect(existsSync(backupPath)).toBe(true);
		expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual(original);
		// Source is unmodified — no hasCompletedOnboarding rewrite.
		expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(original);

		const jsonResult = results.find((r) => r.kind === "claude-json");
		expect(jsonResult?.backupPath).toBe(backupPath);
		expect(jsonResult?.created).toBe(true);
	});

	test("backs up an existing .credentials.json and leaves the original intact", async () => {
		const dir = join(tempDir, ".claude");
		const credPath = join(dir, ".credentials.json");
		const credBackup = `${credPath}.backup`;
		mkdirSync(dir, { recursive: true });
		const original = { session: "user-session" };
		writeFileSync(credPath, JSON.stringify(original));

		const { backupClaudeAuth } = await import("@/lib/configure.js");
		const results = backupClaudeAuth();

		expect(existsSync(credBackup)).toBe(true);
		expect(JSON.parse(readFileSync(credBackup, "utf-8"))).toEqual(original);
		// Source still on disk and unchanged — credentials are NOT removed.
		expect(existsSync(credPath)).toBe(true);
		expect(JSON.parse(readFileSync(credPath, "utf-8"))).toEqual(original);

		const credResult = results.find((r) => r.kind === "claude-credentials");
		expect(credResult?.backupPath).toBe(credBackup);
		expect(credResult?.created).toBe(true);
	});

	test("noop when neither .claude.json nor .credentials.json exists", async () => {
		const { backupClaudeAuth } = await import("@/lib/configure.js");
		const results = backupClaudeAuth();

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude.json.backup"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude", ".credentials.json"))).toBe(
			false,
		);

		expect(
			results.find((r) => r.kind === "claude-json")?.backupPath,
		).toBeNull();
		expect(
			results.find((r) => r.kind === "claude-credentials")?.backupPath,
		).toBeNull();
	});

	test("preserves a pre-existing .claude.json.backup and leaves the live file alone", async () => {
		const filePath = join(tempDir, ".claude.json");
		const backupPath = `${filePath}.backup`;
		writeFileSync(backupPath, JSON.stringify({ marker: "original" }));
		const newer = { marker: "newer-content" };
		writeFileSync(filePath, JSON.stringify(newer));

		const { backupClaudeAuth } = await import("@/lib/configure.js");
		backupClaudeAuth();

		// Original backup is the authoritative pre-CoDev state — never clobbered.
		expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual({
			marker: "original",
		});
		// Live file also untouched (no destructive writes from backup-only path).
		expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(newer);
	});

	test("preserves a pre-existing .credentials.json.backup and leaves the live file alone", async () => {
		const dir = join(tempDir, ".claude");
		const credPath = join(dir, ".credentials.json");
		const credBackup = `${credPath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(credBackup, JSON.stringify({ session: "original" }));
		const newer = { session: "newer-session" };
		writeFileSync(credPath, JSON.stringify(newer));

		const { backupClaudeAuth } = await import("@/lib/configure.js");
		backupClaudeAuth();

		expect(JSON.parse(readFileSync(credBackup, "utf-8"))).toEqual({
			session: "original",
		});
		expect(JSON.parse(readFileSync(credPath, "utf-8"))).toEqual(newer);
	});

	test("a subsequent resetClaudeAuth() preserves the backup created by backupClaudeAuth()", async () => {
		const filePath = join(tempDir, ".claude.json");
		const backupPath = `${filePath}.backup`;
		const original = { marker: "pre-codev" };
		writeFileSync(filePath, JSON.stringify(original));

		const { backupClaudeAuth, resetClaudeAuth } = await import(
			"@/lib/configure.js"
		);
		backupClaudeAuth();
		// After backup-only, source is intact.
		expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(original);
		expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual(original);

		resetClaudeAuth();
		// Backup still holds the original contents (not overwritten by reset).
		expect(JSON.parse(readFileSync(backupPath, "utf-8"))).toEqual(original);
		// And reset's destructive write happened.
		expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({
			hasCompletedOnboarding: true,
		});
	});
});

describe("configureClaudeCode", () => {
	test("creates ~/.claude/settings.json with env block when file does not exist", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({ apiKey: "sk-abc", model: "chosen-model" });

		const filePath = join(tempDir, ".claude", "settings.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe(
			"https://json.schemastore.org/claude-code-settings.json",
		);
		expect(config.env).toEqual({
			ANTHROPIC_BASE_URL: AI_GATEWAY_URL(),
			ANTHROPIC_API_KEY: "sk-abc",
			ANTHROPIC_MODEL: "chosen-model",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "chosen-model",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "chosen-model",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "chosen-model",
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: "196608",
			CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "85",
		});
	});

	test("does not touch ~/.claude.json on its own (handled by resetClaudeAuth earlier in the install flow)", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({ apiKey: "sk-abc", model: "m" });

		// configureClaudeCode only owns ~/.claude/settings.json. The onboarding
		// bypass and credentials wipe happen during install via resetClaudeAuth.
		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
		expect(existsSync(join(tempDir, ".claude", ".credentials.json"))).toBe(
			false,
		);
	});

	test("replaces existing settings.json and backs up the file", async () => {
		const dir = join(tempDir, ".claude");
		const filePath = join(dir, "settings.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				otherKey: "keep",
				env: { FOO: "bar", ANTHROPIC_API_KEY: "old" },
			}),
		);

		const { configureClaudeCode } = await import("@/lib/configure.js");
		const results = configureClaudeCode({ apiKey: "sk-new", model: "m" });

		const result = results.find((r) => r.kind === "claude-settings");
		expect(result?.backupPath).toBe(backupPath);
		expect(existsSync(backupPath)).toBe(true);

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.otherKey).toBe("keep");
		expect(backup.env.ANTHROPIC_API_KEY).toBe("old");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.otherKey).toBeUndefined();
		expect(config.env.FOO).toBeUndefined();
		expect(config.env.ANTHROPIC_API_KEY).toBe("sk-new");
	});

	test("does not touch unrelated files in ~/.claude", async () => {
		const dir = join(tempDir, ".claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: {} }));
		writeFileSync(join(dir, "CLAUDE.md"), "user notes");

		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({ apiKey: "sk-new", model: "m" });

		expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("user notes");
		expect(existsSync(join(dir, "CLAUDE.md.backup"))).toBe(false);
	});

	test("preserves a pre-existing settings.json backup across repeated runs", async () => {
		const dir = join(tempDir, ".claude");
		const filePath = join(dir, "settings.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, JSON.stringify({ marker: "original" }));
		writeFileSync(
			filePath,
			JSON.stringify({ env: { ANTHROPIC_API_KEY: "prev-codev-run" } }),
		);

		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({ apiKey: "sk-new", model: "m" });

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.marker).toBe("original");
	});

	test("uses only `creds.model` even when `models` lists more — Claude Code has no list slot", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({
			apiKey: "sk-abc",
			model: "primary",
			models: ["primary", "secondary", "tertiary"],
		});

		const filePath = join(tempDir, ".claude", "settings.json");
		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.env.ANTHROPIC_MODEL).toBe("primary");
		expect(config.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("primary");
		expect(config.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("primary");
		expect(config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("primary");
		// No secondary/tertiary should land anywhere in the settings blob.
		expect(JSON.stringify(config)).not.toContain("secondary");
		expect(JSON.stringify(config)).not.toContain("tertiary");
	});
});

describe("configureOpenCode", () => {
	test("creates ~/.config/opencode/opencode.json with aigateway provider when file does not exist", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({ apiKey: "sk-xyz", model: "chosen-model" });

		const filePath = join(tempDir, ".config", "opencode", "opencode.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe("https://opencode.ai/config.json");
		expect(config.provider.aigateway.npm).toBe("@ai-sdk/openai-compatible");
		expect(config.provider.aigateway.options.baseURL).toBe(
			AI_GATEWAY_OPENAI_URL(),
		);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-xyz");
		expect(config.provider.aigateway.models["chosen-model"].name).toBe(
			"chosen-model",
		);
		// Top-level `model` pins the active default in <provider>/<modelId> form.
		expect(config.model).toBe("aigateway/chosen-model");
		// Declares the gateway window so OpenCode sizes context correctly and its
		// auto-compaction fires (a model with no `limit` defaults to context 0,
		// which disables compaction). `output` is required alongside `context`.
		expect(config.provider.aigateway.models["chosen-model"].limit).toEqual({
			context: 196608,
			output: 65536,
		});
		// Reserve lands the compaction trigger at ~85% of the window (196608 −
		// 29491 ≈ 167K), matching Claude Code and Codex.
		expect(config.compaction).toEqual({ auto: true, reserved: 29491 });
	});

	test("writes every fetched model into the provider's models map", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({
			apiKey: "sk-xyz",
			model: "model-a",
			models: ["model-a", "model-b", "model-c"],
		});

		const filePath = join(tempDir, ".config", "opencode", "opencode.json");
		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		const map = config.provider.aigateway.models;
		expect(Object.keys(map).sort()).toEqual(["model-a", "model-b", "model-c"]);
		for (const id of ["model-a", "model-b", "model-c"]) {
			expect(map[id].name).toBe(id);
			expect(map[id].limit).toEqual({ context: 196608, output: 65536 });
		}
		// Top-level default still points at the chosen one.
		expect(config.model).toBe("aigateway/model-a");
	});

	test("falls back to [model] when `models` is absent (older call sites)", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({ apiKey: "sk-xyz", model: "solo-model" });

		const filePath = join(tempDir, ".config", "opencode", "opencode.json");
		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		const map = config.provider.aigateway.models;
		expect(Object.keys(map)).toEqual(["solo-model"]);
	});

	test("treats an empty `models` array as 'no list' and falls back to [model]", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({
			apiKey: "sk-xyz",
			model: "solo-model",
			models: [],
		});

		const filePath = join(tempDir, ".config", "opencode", "opencode.json");
		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		const map = config.provider.aigateway.models;
		expect(Object.keys(map)).toEqual(["solo-model"]);
	});

	test("does not touch ~/.claude.json (OpenCode-only install)", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({ apiKey: "sk-xyz", model: "m" });

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
	});

	test("replaces existing opencode.json and backs up the file", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const filePath = join(dir, "opencode.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				someSetting: "keep",
				provider: { other: { name: "Other" } },
			}),
		);

		const { configureOpenCode } = await import("@/lib/configure.js");
		const results = configureOpenCode({ apiKey: "sk-new", model: "m" });

		expect(results[0]?.backupPath).toBe(backupPath);
		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.someSetting).toBe("keep");
		expect(backup.provider.other.name).toBe("Other");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.someSetting).toBeUndefined();
		expect(config.provider.other).toBeUndefined();
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});

	test("carries the `mcp` map across a rewrite (CodeGraph wiring survives reconfigure)", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const filePath = join(dir, "opencode.json");
		mkdirSync(dir, { recursive: true });
		// A config CoDev wrote earlier, since wired with MCP servers (CodeGraph's
		// entry plus one of the user's own) — the state every gateway-key
		// auto-refresh and model switch rewrites.
		writeFileSync(
			filePath,
			JSON.stringify({
				provider: { aigateway: { options: { apiKey: "sk-old" } } },
				mcp: {
					codegraph: {
						type: "local",
						command: ["codegraph", "serve", "--mcp"],
						enabled: true,
					},
					mine: { type: "local", command: ["mine"], enabled: true },
				},
			}),
		);

		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({ apiKey: "sk-new", model: "m" });

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.mcp.codegraph.command).toEqual([
			"codegraph",
			"serve",
			"--mcp",
		]);
		expect(config.mcp.mine.command).toEqual(["mine"]);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});

	test("does not carry a non-object `mcp` value across a rewrite", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const filePath = join(dir, "opencode.json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, JSON.stringify({ mcp: "not a server map" }));

		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({ apiKey: "sk-new", model: "m" });

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.mcp).toBeUndefined();
	});

	test("preserves a pre-existing opencode.json backup across repeated runs", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const filePath = join(dir, "opencode.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, JSON.stringify({ marker: "original" }));
		writeFileSync(
			filePath,
			JSON.stringify({
				provider: { aigateway: { options: { apiKey: "prev-codev-run" } } },
			}),
		);

		const { configureOpenCode } = await import("@/lib/configure.js");
		const results = configureOpenCode({ apiKey: "sk-new", model: "m" });

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.marker).toBe("original");
		expect(results[0]?.backupPath).toBe(backupPath);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});
});

describe("configureCodevCode", () => {
	test("creates ~/.config/codev/codev.json with aigateway provider when file does not exist", async () => {
		const { configureCodevCode } = await import("@/lib/configure.js");
		configureCodevCode({ apiKey: "sk-xyz", model: "chosen-model" });

		const filePath = join(tempDir, ".config", "codev", "codev.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.$schema).toBe("https://opencode.ai/config.json");
		expect(config.provider.aigateway.npm).toBe("@ai-sdk/openai-compatible");
		expect(config.provider.aigateway.options.baseURL).toBe(
			AI_GATEWAY_OPENAI_URL(),
		);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-xyz");
		expect(config.provider.aigateway.models["chosen-model"].name).toBe(
			"chosen-model",
		);
		// Top-level `model` pins the active default in <provider>/<modelId> form.
		expect(config.model).toBe("aigateway/chosen-model");
		// The fork shares OpenCode's window/compaction handling, so the same
		// limit + compaction blocks must land in its config.
		expect(config.provider.aigateway.models["chosen-model"].limit).toEqual({
			context: 196608,
			output: 65536,
		});
		expect(config.compaction).toEqual({ auto: true, reserved: 29491 });
	});

	test("does not touch ~/.config/opencode/opencode.json (fork-only install)", async () => {
		const { configureCodevCode } = await import("@/lib/configure.js");
		configureCodevCode({ apiKey: "sk-xyz", model: "m" });

		expect(
			existsSync(join(tempDir, ".config", "opencode", "opencode.json")),
		).toBe(false);
	});

	test("replaces existing codev.json and backs up the file", async () => {
		const dir = join(tempDir, ".config", "codev");
		const filePath = join(dir, "codev.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				someSetting: "keep",
				provider: { other: { name: "Other" } },
			}),
		);

		const { configureCodevCode } = await import("@/lib/configure.js");
		const results = configureCodevCode({ apiKey: "sk-new", model: "m" });

		expect(results[0]?.kind).toBe("codev-code-config");
		expect(results[0]?.backupPath).toBe(backupPath);
		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.someSetting).toBe("keep");
		expect(backup.provider.other.name).toBe("Other");

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.someSetting).toBeUndefined();
		expect(config.provider.other).toBeUndefined();
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});

	test("carries the `mcp` map across a rewrite (CodeGraph wiring survives reconfigure)", async () => {
		const dir = join(tempDir, ".config", "codev");
		const filePath = join(dir, "codev.json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			filePath,
			JSON.stringify({
				provider: { aigateway: { options: { apiKey: "sk-old" } } },
				mcp: {
					codegraph: {
						type: "local",
						command: ["codegraph", "serve", "--mcp"],
						enabled: true,
					},
				},
			}),
		);

		const { configureCodevCode } = await import("@/lib/configure.js");
		configureCodevCode({ apiKey: "sk-new", model: "m" });

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.mcp.codegraph.command).toEqual([
			"codegraph",
			"serve",
			"--mcp",
		]);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});

	test("preserves a pre-existing codev.json backup across repeated runs", async () => {
		const dir = join(tempDir, ".config", "codev");
		const filePath = join(dir, "codev.json");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, JSON.stringify({ marker: "original" }));
		writeFileSync(
			filePath,
			JSON.stringify({
				provider: { aigateway: { options: { apiKey: "prev-codev-run" } } },
			}),
		);

		const { configureCodevCode } = await import("@/lib/configure.js");
		const results = configureCodevCode({ apiKey: "sk-new", model: "m" });

		const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
		expect(backup.marker).toBe("original");
		expect(results[0]?.backupPath).toBe(backupPath);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.provider.aigateway.options.apiKey).toBe("sk-new");
	});
});

describe("configureCodex", () => {
	function readCodexToml() {
		return TOML.parse(
			readFileSync(join(tempDir, ".codex", "config.toml"), "utf-8"),
		) as {
			model: string;
			model_provider: string;
			model_context_window: number;
			model_auto_compact_token_limit: number;
			model_providers: Record<
				string,
				{
					name: string;
					base_url: string;
					wire_api: string;
					experimental_bearer_token: string;
				}
			>;
		};
	}

	test("creates ~/.codex/config.toml with aigateway provider when file does not exist", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({ apiKey: "sk-codex", model: "chosen-model" });

		const filePath = join(tempDir, ".codex", "config.toml");
		expect(existsSync(filePath)).toBe(true);

		const config = readCodexToml();
		expect(config.model).toBe("chosen-model");
		expect(config.model_provider).toBe("aigateway");
		expect(config.model_providers.aigateway).toBeDefined();
		expect(config.model_providers.aigateway?.name).toBe("AI Gateway");
		expect(config.model_providers.aigateway?.base_url).toBe(
			AI_GATEWAY_OPENAI_URL(),
		);
		expect(config.model_providers.aigateway?.wire_api).toBe("responses");
		expect(config.model_providers.aigateway?.experimental_bearer_token).toBe(
			"sk-codex",
		);
	});

	test("pins the gateway window and compaction trigger (Codex would otherwise assume a larger fallback window)", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({ apiKey: "sk-codex", model: "m" });

		const config = readCodexToml();
		expect(config.model_context_window).toBe(196608);
		expect(config.model_auto_compact_token_limit).toBe(167117); // ≈85% of the window
	});

	test("does not touch ~/.claude.json (Codex-only install)", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({ apiKey: "sk-codex", model: "m" });

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
	});

	test("replaces existing config.toml and backs up the file", async () => {
		const dir = join(tempDir, ".codex");
		const filePath = join(dir, "config.toml");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, 'model = "old"\nother = "keep"\n');

		const { configureCodex } = await import("@/lib/configure.js");
		const results = configureCodex({ apiKey: "sk-new", model: "m" });

		expect(results[0]?.backupPath).toBe(backupPath);
		expect(existsSync(backupPath)).toBe(true);

		const backup = readFileSync(backupPath, "utf-8");
		expect(backup).toContain('model = "old"');
		expect(backup).toContain('other = "keep"');

		const config = readCodexToml();
		expect(config.model_providers.aigateway?.experimental_bearer_token).toBe(
			"sk-new",
		);
	});

	test("preserves a pre-existing config.toml backup across repeated runs", async () => {
		const dir = join(tempDir, ".codex");
		const filePath = join(dir, "config.toml");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, 'marker = "original"\n');
		writeFileSync(filePath, 'marker = "prev-codev-run"\n');

		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({ apiKey: "sk-new", model: "m" });

		const backup = readFileSync(backupPath, "utf-8");
		expect(backup).toContain('marker = "original"');
	});

	test("uses only `creds.model` even when `models` lists more — Codex has no list slot", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({
			apiKey: "sk-codex",
			model: "primary",
			models: ["primary", "secondary", "tertiary"],
		});

		const filePath = join(tempDir, ".codex", "config.toml");
		const raw = readFileSync(filePath, "utf-8");
		const config = readCodexToml();
		expect(config.model).toBe("primary");
		expect(raw).not.toContain("secondary");
		expect(raw).not.toContain("tertiary");
	});

	test("uses supplied baseUrl with /v1 already present", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({
			apiKey: "k",
			baseUrl: "https://example.com/v1",
			model: "m",
		});

		const config = readCodexToml();
		expect(config.model_providers.aigateway?.base_url).toBe(
			"https://example.com/v1",
		);
		expect(config.model).toBe("m");
	});

	test("appends /v1 when baseUrl has no trailing slash", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({
			apiKey: "k",
			baseUrl: "https://example.com",
			model: "m",
		});

		const config = readCodexToml();
		expect(config.model_providers.aigateway?.base_url).toBe(
			"https://example.com/v1",
		);
	});

	test("appends v1 when baseUrl ends with a trailing slash", async () => {
		const { configureCodex } = await import("@/lib/configure.js");
		configureCodex({
			apiKey: "k",
			baseUrl: "https://example.com/",
			model: "m",
		});

		const config = readCodexToml();
		expect(config.model_providers.aigateway?.base_url).toBe(
			"https://example.com/v1",
		);
	});
});

describe("configureContinue", () => {
	function readContinueYaml(): string {
		return readFileSync(join(tempDir, ".continue", "config.yaml"), "utf-8");
	}

	test("creates ~/.continue/config.yaml with CoDev marker when file does not exist", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({ apiKey: "sk-vscode", model: "chosen-model" });

		const filePath = join(tempDir, ".continue", "config.yaml");
		expect(existsSync(filePath)).toBe(true);
		const raw = readContinueYaml();
		expect(raw).toContain("CoDev (AI Gateway)");
		// OpenAI-compatible provider entry pinned to the gateway's /v1 endpoint.
		expect(raw).toContain(`provider: "openai"`);
		expect(raw).toContain(`apiBase: "${AI_GATEWAY_OPENAI_URL()}"`);
		expect(raw).toContain(`apiKey: "sk-vscode"`);
		expect(raw).toContain(`name: "chosen-model"`);
		expect(raw).toContain(`model: "chosen-model"`);
	});

	test("emits one model entry per fetched model", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({
			apiKey: "sk",
			model: "model-a",
			models: ["model-a", "model-b", "model-c"],
		});

		const raw = readContinueYaml();
		// Each model id should appear in its own `name:` entry. Continue's openai
		// provider lists each model as a top-level entry under `models:`.
		expect(raw.match(/^\s*-\s+name:\s+"model-a"$/m)).not.toBeNull();
		expect(raw.match(/^\s*-\s+name:\s+"model-b"$/m)).not.toBeNull();
		expect(raw.match(/^\s*-\s+name:\s+"model-c"$/m)).not.toBeNull();
	});

	test("falls back to [model] when `models` is absent", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({ apiKey: "sk", model: "solo-model" });

		const raw = readContinueYaml();
		expect(raw.match(/^\s*-\s+name:\s+"solo-model"$/m)).not.toBeNull();
		// No other model entries.
		const matches = raw.match(/^\s*-\s+name:/gm) ?? [];
		expect(matches.length).toBe(1);
	});

	test("appends /v1 to a user-supplied base URL with no v1 suffix", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({
			apiKey: "sk",
			baseUrl: "https://example.com",
			model: "m",
		});

		const raw = readContinueYaml();
		expect(raw).toContain(`apiBase: "https://example.com/v1"`);
	});

	test("preserves a base URL that already ends with /v1", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({
			apiKey: "sk",
			baseUrl: "https://example.com/v1",
			model: "m",
		});

		const raw = readContinueYaml();
		expect(raw).toContain(`apiBase: "https://example.com/v1"`);
	});

	test("replaces existing config.yaml and backs up the file", async () => {
		const dir = join(tempDir, ".continue");
		const filePath = join(dir, "config.yaml");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		const original = 'name: "User Config"\nmodels:\n  - name: "old"\n';
		writeFileSync(filePath, original);

		const { configureContinue } = await import("@/lib/configure.js");
		const results = configureContinue({
			apiKey: "sk-new",
			model: "m",
		});

		expect(results[0]?.backupPath).toBe(backupPath);
		expect(existsSync(backupPath)).toBe(true);
		expect(readFileSync(backupPath, "utf-8")).toBe(original);

		const raw = readContinueYaml();
		expect(raw).toContain("CoDev (AI Gateway)");
		expect(raw).not.toContain("User Config");
	});

	test("preserves a pre-existing config.yaml backup across repeated runs", async () => {
		const dir = join(tempDir, ".continue");
		const filePath = join(dir, "config.yaml");
		const backupPath = `${filePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, 'name: "original-user-config"\n');
		writeFileSync(filePath, 'name: "prev-codev-run"\n');

		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({ apiKey: "sk-new", model: "m" });

		expect(readFileSync(backupPath, "utf-8")).toContain("original-user-config");
	});

	test("does not touch ~/.claude.json (VS Code-only install)", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		configureContinue({ apiKey: "sk", model: "m" });

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
	});

	test("escapes embedded double quotes and backslashes in scalar values", async () => {
		const { configureContinue } = await import("@/lib/configure.js");
		// API keys can in theory contain any byte; the YAML emitter must not
		// produce a malformed scalar for a key that includes `"` or `\`.
		configureContinue({
			apiKey: 'sk-with-"quote"-and-\\back',
			model: "m",
		});

		const raw = readContinueYaml();
		expect(raw).toContain(`apiKey: "sk-with-\\"quote\\"-and-\\\\back"`);
	});
});

// OpenCode and the codev-code fork share a config loader, so they share its
// hazard: each reads <base>.json *and* <base>.jsonc, deep-merging json then
// jsonc, so a jsonc the agent wrote (via its auto-seeded stub, or `codev
// configure`) would silently shadow anything we put in the json. We target
// whichever file the agent's own globalConfigFile() would.
describe.each([
	{ tool: "opencode", dir: "opencode", base: "opencode" },
	{ tool: "codev-code", dir: "codev", base: "codev" },
] as const)("$tool config targeting ($base.json vs $base.jsonc)", (agent) => {
	const configDir = () => join(tempDir, ".config", agent.dir);
	const at = (suffix: string) => join(configDir(), `${agent.base}${suffix}`);
	const seed = (suffix: string, body: string) => {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(at(suffix), body);
	};
	const target = async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		return getBackupStatus(agent.tool)[0]?.sourcePath;
	};
	const configure = async (creds: { apiKey: string; model: string }) => {
		const mod = await import("@/lib/configure.js");
		const fn =
			agent.tool === "opencode"
				? mod.configureOpenCode
				: mod.configureCodevCode;
		return fn({ ...creds, baseUrl: "https://gw.test/v1" });
	};

	test("targets the .json when neither file exists", async () => {
		// Also keeps the agent from auto-seeding a jsonc later: its
		// globalConfigFile() finds the .json first and leaves it alone.
		expect(await target()).toBe(at(".json"));
	});

	test("targets an existing .jsonc, which would otherwise shadow us", async () => {
		seed(".jsonc", '{"$schema":"https://opencode.ai/config.json"}');
		expect(await target()).toBe(at(".jsonc"));
	});

	test("prefers the .jsonc when both exist, matching the agent's merge order", async () => {
		seed(".json", "{}");
		seed(".jsonc", "{}");
		expect(await target()).toBe(at(".jsonc"));
	});

	test("a backup pins the file we already configured, even once a jsonc appears", async () => {
		// Without this the backup would strand: restore would follow the live
		// jsonc, find no .jsonc.backup, and never restore the .json.
		seed(".json", "{}");
		seed(".json.backup", '{"original":true}');
		seed(".jsonc", "{}");
		expect(await target()).toBe(at(".json"));
	});

	test("configures a jsonc in place and backs it up under the .jsonc name", async () => {
		seed(".jsonc", '{"marker":"original"}');
		const [result] = await configure({ apiKey: "k", model: "m" });

		expect(result?.sourcePath).toBe(at(".jsonc"));
		expect(result?.backupPath).toBe(at(".jsonc.backup"));
		// No stray .json — one gateway block, in the file the agent reads.
		expect(existsSync(at(".json"))).toBe(false);
		expect(JSON.parse(readFileSync(at(".jsonc.backup"), "utf-8"))).toEqual({
			marker: "original",
		});
		const written = JSON.parse(readFileSync(at(".jsonc"), "utf-8"));
		expect(written.provider.aigateway.options.apiKey).toBe("k");
	});

	test("reads a jsonc containing comments and trailing commas", async () => {
		// A hand-written jsonc is the whole reason .jsonc exists; JSON.parse would
		// throw here and take `codevhub upload` down with it.
		seed(
			".jsonc",
			`{
				// the gateway CoDev configured
				"provider": { "aigateway": { "options": { "baseURL": "https://gw.test/v1" } } },
			}`,
		);
		const { readAgentConfig } = await import("@/lib/configure.js");
		expect(readAgentConfig(agent.tool)).toEqual({
			baseUrl: "https://gw.test/v1",
		});
	});

	test("restores a configured jsonc from its backup", async () => {
		seed(".jsonc", '{"marker":"live"}');
		seed(".jsonc.backup", '{"marker":"backup"}');
		const { restoreTool } = await import("@/lib/configure.js");
		const [result] = restoreTool(agent.tool);

		expect(result?.status).toBe("restored");
		expect(JSON.parse(readFileSync(at(".jsonc"), "utf-8"))).toEqual({
			marker: "backup",
		});
		expect(existsSync(at(".jsonc.backup"))).toBe(false);
	});
});

describe("getBackupStatus", () => {
	test("returns claude-settings for claude-code", async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		const statuses = getBackupStatus("claude-code");
		expect(statuses.map((s) => s.kind)).toEqual(["claude-settings"]);
	});

	test("returns opencode-config for opencode", async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		const statuses = getBackupStatus("opencode");
		expect(statuses.map((s) => s.kind)).toEqual(["opencode-config"]);
	});

	test("returns codex-config for codex", async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		const statuses = getBackupStatus("codex");
		expect(statuses.map((s) => s.kind)).toEqual(["codex-config"]);
	});

	test("returns codev-code-config for codev-code", async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		const statuses = getBackupStatus("codev-code");
		expect(statuses.map((s) => s.kind)).toEqual(["codev-code-config"]);
		expect(statuses[0]?.sourcePath).toBe(
			join(tempDir, ".config", "codev", "codev.json"),
		);
	});

	test("returns continue-config for vscode-continue", async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		const statuses = getBackupStatus("vscode-continue");
		expect(statuses.map((s) => s.kind)).toEqual(["continue-config"]);
		expect(statuses[0]?.sourcePath).toBe(
			join(tempDir, ".continue", "config.yaml"),
		);
	});

	test("reports hasSource and hasBackup accurately", async () => {
		mkdirSync(join(tempDir, ".config", "opencode"), { recursive: true });
		writeFileSync(join(tempDir, ".config", "opencode", "opencode.json"), "{}");

		const { getBackupStatus } = await import("@/lib/configure.js");
		const [status] = getBackupStatus("opencode");
		expect(status?.hasSource).toBe(true);
		expect(status?.hasBackup).toBe(false);
	});
});

describe("restoreTool", () => {
	test("replaces the live Claude settings.json with the backup", async () => {
		const dir = join(tempDir, ".claude");
		const livePath = join(dir, "settings.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, '{"marker":"live"}');
		writeFileSync(backupPath, '{"marker":"backup"}');

		const { restoreTool } = await import("@/lib/configure.js");
		const results = restoreTool("claude-code");
		const settingsResult = results.find(
			(r) => r.sourcePath === join(dir, "settings.json"),
		);

		expect(settingsResult?.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
		const restored = JSON.parse(readFileSync(livePath, "utf-8"));
		expect(restored.marker).toBe("backup");
	});

	test("does not disturb other files in the target directory", async () => {
		const dir = join(tempDir, ".claude");
		const livePath = join(dir, "settings.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, '{"marker":"live"}');
		writeFileSync(backupPath, '{"marker":"backup"}');
		writeFileSync(join(dir, "CLAUDE.md"), "user notes");

		const { restoreTool } = await import("@/lib/configure.js");
		restoreTool("claude-code");

		expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("user notes");
	});

	test("restores when no live file is present", async () => {
		const dir = join(tempDir, ".config", "opencode");
		const livePath = join(dir, "opencode.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, '{"marker":"backup"}');

		const { restoreTool } = await import("@/lib/configure.js");
		const [result] = restoreTool("opencode");

		expect(result?.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
	});

	test("returns noop status when neither backup nor live file exists", async () => {
		const { restoreTool } = await import("@/lib/configure.js");
		const results = restoreTool("claude-code");

		// All three Claude files end in noop when nothing exists on disk.
		expect(results.every((r) => r.status === "noop")).toBe(true);
		expect(results.map((r) => r.backupPath).sort()).toEqual(
			[
				join(tempDir, ".claude", "settings.json.backup"),
				join(tempDir, ".claude", ".credentials.json.backup"),
				join(tempDir, ".claude.json.backup"),
			].sort(),
		);
	});

	test("deletes the live CoDev config when no backup exists", async () => {
		const livePath = join(tempDir, ".claude", "settings.json");
		const backupPath = `${livePath}.backup`;
		// Written by the real writer, not a hand-rolled marker: the authorship
		// gate reads the keys the writer emits, so a fake fixture would let the
		// two drift apart while this test kept passing.
		const { configureClaudeCode, restoreTool } = await import(
			"@/lib/configure.js"
		);
		configureClaudeCode({ apiKey: "sk-test", model: "test-model" });
		expect(existsSync(livePath)).toBe(true);

		const results = restoreTool("claude-code");
		const settingsResult = results.find((r) => r.sourcePath === livePath);

		expect(settingsResult?.status).toBe("deleted");
		// No backup means nothing preceded it, so deleting is the pre-CoDev state.
		expect(existsSync(livePath)).toBe(false);
		expect(existsSync(backupPath)).toBe(false);
	});

	test("keeps a live user-written config when no backup exists", async () => {
		const dir = join(tempDir, ".claude");
		const livePath = join(dir, "settings.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, '{"marker":"user-authored"}');

		const { restoreTool } = await import("@/lib/configure.js");
		const results = restoreTool("claude-code");
		const settingsResult = results.find((r) => r.sourcePath === livePath);

		expect(settingsResult?.status).toBe("kept-live");
		// No CoDev marker, so we can't know what preceded it — left untouched.
		expect(existsSync(livePath)).toBe(true);
		expect(readFileSync(livePath, "utf-8")).toBe('{"marker":"user-authored"}');
		expect(existsSync(backupPath)).toBe(false);
	});

	test("replaces the live Continue config.yaml with the backup", async () => {
		const dir = join(tempDir, ".continue");
		const livePath = join(dir, "config.yaml");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, 'name: "live"\n');
		writeFileSync(backupPath, 'name: "backup"\n');

		const { restoreTool } = await import("@/lib/configure.js");
		const [result] = restoreTool("vscode-continue");

		expect(result?.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(readFileSync(livePath, "utf-8")).toContain('name: "backup"');
	});

	test("replaces the live Codex config.toml with the backup", async () => {
		const dir = join(tempDir, ".codex");
		const livePath = join(dir, "config.toml");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, 'marker = "live"\n');
		writeFileSync(backupPath, 'marker = "backup"\n');

		const { restoreTool } = await import("@/lib/configure.js");
		const [result] = restoreTool("codex");

		expect(result?.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(readFileSync(livePath, "utf-8")).toContain('marker = "backup"');
	});

	test("replaces the live CoDev Code codev.json with the backup", async () => {
		const dir = join(tempDir, ".config", "codev");
		const livePath = join(dir, "codev.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, '{"marker":"live"}');
		writeFileSync(backupPath, '{"marker":"backup"}');

		const { restoreTool } = await import("@/lib/configure.js");
		const [result] = restoreTool("codev-code");

		expect(result?.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		const restored = JSON.parse(readFileSync(livePath, "utf-8"));
		expect(restored.marker).toBe("backup");
	});

	test("Claude bundle: restores all three files when all backups exist", async () => {
		const claudeDir = join(tempDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });

		const settingsLive = join(claudeDir, "settings.json");
		const settingsBackup = `${settingsLive}.backup`;
		writeFileSync(settingsLive, '{"env":{"ANTHROPIC_API_KEY":"codev"}}');
		writeFileSync(settingsBackup, '{"marker":"settings-original"}');

		const jsonLive = join(tempDir, ".claude.json");
		const jsonBackup = `${jsonLive}.backup`;
		writeFileSync(jsonLive, '{"hasCompletedOnboarding":true}');
		writeFileSync(jsonBackup, '{"marker":"json-original"}');

		const credLive = join(claudeDir, ".credentials.json");
		const credBackup = `${credLive}.backup`;
		// .credentials.json is wiped on install — the live file here represents
		// a fresh one the CLI created post-install. The backup is what existed
		// before CoDev touched the system.
		writeFileSync(credLive, '{"session":"post-install"}');
		writeFileSync(credBackup, '{"marker":"cred-original"}');

		const { restoreTool } = await import("@/lib/configure.js");
		const results = restoreTool("claude-code");

		expect(results.every((r) => r.status === "restored")).toBe(true);
		expect(JSON.parse(readFileSync(settingsLive, "utf-8"))).toEqual({
			marker: "settings-original",
		});
		expect(JSON.parse(readFileSync(jsonLive, "utf-8"))).toEqual({
			marker: "json-original",
		});
		expect(JSON.parse(readFileSync(credLive, "utf-8"))).toEqual({
			marker: "cred-original",
		});
		// All backups consumed.
		expect(existsSync(settingsBackup)).toBe(false);
		expect(existsSync(jsonBackup)).toBe(false);
		expect(existsSync(credBackup)).toBe(false);
	});

	test("Claude bundle: restores from backup, deletes CoDev's backup-less files", async () => {
		const claudeDir = join(tempDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });

		// Settings has a backup → restored.
		const settingsLive = join(claudeDir, "settings.json");
		writeFileSync(settingsLive, '{"env":{}}');
		writeFileSync(`${settingsLive}.backup`, '{"marker":"orig"}');

		// Exactly the stub resetClaudeAuth writes → CoDev's, so deleted.
		const jsonLive = join(tempDir, ".claude.json");
		writeFileSync(jsonLive, '{"hasCompletedOnboarding":true}');

		// CoDev never writes .credentials.json, only removes it, so a live one
		// with no backup is a post-CoDev login → ours to clear.
		const credLive = join(claudeDir, ".credentials.json");
		writeFileSync(credLive, '{"session":"post-install"}');

		const { restoreTool } = await import("@/lib/configure.js");
		const results = restoreTool("claude-code");

		const byKind = new Map(results.map((r) => [r.sourcePath, r.status]));
		expect(byKind.get(settingsLive)).toBe("restored");
		expect(byKind.get(jsonLive)).toBe("deleted");
		expect(byKind.get(credLive)).toBe("deleted");

		expect(existsSync(jsonLive)).toBe(false);
		expect(existsSync(credLive)).toBe(false);
		expect(JSON.parse(readFileSync(settingsLive, "utf-8"))).toEqual({
			marker: "orig",
		});
	});

	// ~/.claude.json carries real user state (projects, history, mcpServers).
	// Only the bare onboarding stub is ours; anything richer is the user's.
	test("Claude bundle: keeps a .claude.json holding real user state", async () => {
		const jsonLive = join(tempDir, ".claude.json");
		writeFileSync(
			jsonLive,
			JSON.stringify({
				hasCompletedOnboarding: true,
				projects: { "/work/app": { history: ["hello"] } },
			}),
		);

		const { restoreTool } = await import("@/lib/configure.js");
		const results = restoreTool("claude-code");

		const byKind = new Map(results.map((r) => [r.sourcePath, r.status]));
		expect(byKind.get(jsonLive)).toBe("kept-live");
		expect(existsSync(jsonLive)).toBe(true);
		expect(JSON.parse(readFileSync(jsonLive, "utf-8")).projects).toEqual({
			"/work/app": { history: ["hello"] },
		});
	});
});

describe("backupOnly", () => {
	test("creates a backup of the live Claude settings.json without writing config", async () => {
		const dir = join(tempDir, ".claude");
		const livePath = join(dir, "settings.json");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		const original = JSON.stringify({ env: { ANTHROPIC_API_KEY: "user-key" } });
		writeFileSync(livePath, original);

		const { backupOnly } = await import("@/lib/configure.js");
		const results = backupOnly("claude-code");

		const result = results[0];
		expect(result?.kind).toBe("claude-settings");
		expect(result?.backupPath).toBe(backupPath);
		expect(result?.created).toBe(true);
		expect(existsSync(backupPath)).toBe(true);
		expect(readFileSync(backupPath, "utf-8")).toBe(original);
		// Live config is left untouched.
		expect(readFileSync(livePath, "utf-8")).toBe(original);
	});

	test("preserves a pre-existing backup", async () => {
		const dir = join(tempDir, ".codex");
		const livePath = join(dir, "config.toml");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(backupPath, 'marker = "original"\n');
		writeFileSync(livePath, 'marker = "current"\n');

		const { backupOnly } = await import("@/lib/configure.js");
		const results = backupOnly("codex");

		expect(results[0]?.backupPath).toBe(backupPath);
		expect(results[0]?.created).toBe(false);
		expect(readFileSync(backupPath, "utf-8")).toContain('marker = "original"');
		expect(readFileSync(livePath, "utf-8")).toContain('marker = "current"');
	});

	test("creates a backup of the live Continue config.yaml without writing config", async () => {
		const dir = join(tempDir, ".continue");
		const livePath = join(dir, "config.yaml");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		const original = 'name: "user-config"\nmodels: []\n';
		writeFileSync(livePath, original);

		const { backupOnly } = await import("@/lib/configure.js");
		const results = backupOnly("vscode-continue");

		const result = results[0];
		expect(result?.kind).toBe("continue-config");
		expect(result?.backupPath).toBe(backupPath);
		expect(result?.created).toBe(true);
		expect(readFileSync(backupPath, "utf-8")).toBe(original);
		expect(readFileSync(livePath, "utf-8")).toBe(original);
	});

	test("returns null backupPath when neither live nor backup file exists", async () => {
		const { backupOnly } = await import("@/lib/configure.js");
		const results = backupOnly("opencode");

		expect(results[0]?.kind).toBe("opencode-config");
		expect(results[0]?.backupPath).toBeNull();
		expect(results[0]?.created).toBe(false);
		expect(
			existsSync(join(tempDir, ".config", "opencode", "opencode.json.backup")),
		).toBe(false);
	});

	test("does not touch .claude.json or .credentials.json", async () => {
		const dir = join(tempDir, ".claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), "{}");

		const { backupOnly } = await import("@/lib/configure.js");
		backupOnly("claude-code");

		// backupOnly only snapshots settings.json. The .claude.json /
		// .credentials.json handling lives in resetClaudeAuth, which the
		// install flow calls separately right after the install step.
		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
		expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
	});
});

describe("configureClaudeCode with manual credentials", () => {
	test("uses the supplied baseUrl and model verbatim when no v1 suffix", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({
			apiKey: "sk-user",
			baseUrl: "https://example.com/api",
			model: "my-model",
		});

		const config = JSON.parse(
			readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"),
		);
		expect(config.env.ANTHROPIC_BASE_URL).toBe("https://example.com/api");
		expect(config.env.ANTHROPIC_API_KEY).toBe("sk-user");
		expect(config.env.ANTHROPIC_MODEL).toBe("my-model");
		expect(config.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("my-model");
		expect(config.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("my-model");
		expect(config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("my-model");
	});

	test("strips trailing v1 from baseUrl", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({
			apiKey: "k",
			baseUrl: "https://example.com/v1",
			model: "m",
		});

		const config = JSON.parse(
			readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"),
		);
		expect(config.env.ANTHROPIC_BASE_URL).toBe("https://example.com/");
	});

	test("strips trailing v1/ from baseUrl", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({
			apiKey: "k",
			baseUrl: "https://example.com/v1/",
			model: "m",
		});

		const config = JSON.parse(
			readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"),
		);
		expect(config.env.ANTHROPIC_BASE_URL).toBe("https://example.com/");
	});

	test("only strips the trailing v1 segment", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({
			apiKey: "k",
			baseUrl: "https://example.com/api/v1",
			model: "m",
		});

		const config = JSON.parse(
			readFileSync(join(tempDir, ".claude", "settings.json"), "utf-8"),
		);
		expect(config.env.ANTHROPIC_BASE_URL).toBe("https://example.com/api/");
	});
});

describe("configureOpenCode with manual credentials", () => {
	test("uses the supplied baseUrl and model when v1 already present", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({
			apiKey: "sk-user",
			baseUrl: "https://example.com/v1",
			model: "my-model",
		});

		const config = JSON.parse(
			readFileSync(
				join(tempDir, ".config", "opencode", "opencode.json"),
				"utf-8",
			),
		);
		expect(config.provider.aigateway.options.baseURL).toBe(
			"https://example.com/v1",
		);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-user");
		expect(config.provider.aigateway.models["my-model"].name).toBe("my-model");
	});

	test("preserves trailing v1/", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({
			apiKey: "k",
			baseUrl: "https://example.com/v1/",
			model: "m",
		});

		const config = JSON.parse(
			readFileSync(
				join(tempDir, ".config", "opencode", "opencode.json"),
				"utf-8",
			),
		);
		expect(config.provider.aigateway.options.baseURL).toBe(
			"https://example.com/v1/",
		);
	});

	test("appends /v1 when URL has no trailing slash", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({
			apiKey: "k",
			baseUrl: "https://example.com",
			model: "m",
		});

		const config = JSON.parse(
			readFileSync(
				join(tempDir, ".config", "opencode", "opencode.json"),
				"utf-8",
			),
		);
		expect(config.provider.aigateway.options.baseURL).toBe(
			"https://example.com/v1",
		);
	});

	test("appends v1 when URL ends with a trailing slash", async () => {
		const { configureOpenCode } = await import("@/lib/configure.js");
		configureOpenCode({
			apiKey: "k",
			baseUrl: "https://example.com/",
			model: "m",
		});

		const config = JSON.parse(
			readFileSync(
				join(tempDir, ".config", "opencode", "opencode.json"),
				"utf-8",
			),
		);
		expect(config.provider.aigateway.options.baseURL).toBe(
			"https://example.com/v1",
		);
	});
});

describe("detectConfiguredTools", () => {
	function seedClaudeWithCodevMarkers() {
		const dir = join(tempDir, ".claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: AI_GATEWAY_URL(),
					ANTHROPIC_API_KEY: "sk",
					ANTHROPIC_MODEL: "m",
					ANTHROPIC_DEFAULT_OPUS_MODEL: "m",
					ANTHROPIC_DEFAULT_SONNET_MODEL: "m",
					ANTHROPIC_DEFAULT_HAIKU_MODEL: "m",
				},
			}),
		);
	}

	function seedCodexWithCodevMarkers() {
		const dir = join(tempDir, ".codex");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.toml"),
			'model = "m"\nmodel_provider = "aigateway"\n[model_providers.aigateway]\nname = "AI Gateway"\n',
		);
	}

	function seedOpenCodeWithCodevMarkers() {
		const dir = join(tempDir, ".config", "opencode");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "opencode.json"),
			JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				model: "aigateway/m",
				provider: {
					aigateway: { npm: "@ai-sdk/openai-compatible" },
				},
			}),
		);
	}

	function seedCodevCodeWithCodevMarkers() {
		const dir = join(tempDir, ".config", "codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "codev.json"),
			JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				model: "aigateway/m",
				provider: {
					aigateway: { npm: "@ai-sdk/openai-compatible" },
				},
			}),
		);
	}

	function seedContinueWithCodevMarkers() {
		const dir = join(tempDir, ".continue");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.yaml"),
			'name: "CoDev (AI Gateway)"\nversion: "0.0.1"\nschema: "v1"\nmodels:\n  - name: "m"\n',
		);
	}

	test("returns [] when no config files exist", async () => {
		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools()).toEqual([]);
	});

	test("detects all five when each tool has CoDev markers", async () => {
		seedClaudeWithCodevMarkers();
		seedCodexWithCodevMarkers();
		seedOpenCodeWithCodevMarkers();
		seedCodevCodeWithCodevMarkers();
		seedContinueWithCodevMarkers();
		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools().sort()).toEqual([
			"claude-code",
			"codev-code",
			"codex",
			"opencode",
			"vscode-continue",
		]);
	});

	test("detects a codev-code config independently of opencode's", async () => {
		// The fork's config lives in its own XDG dir, so seeding it must not
		// light up `opencode` (and vice versa — see the seed-all test above).
		seedCodevCodeWithCodevMarkers();
		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools()).toEqual(["codev-code"]);
	});

	test("ignores a Continue config without the CoDev marker", async () => {
		const dir = join(tempDir, ".continue");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "config.yaml"),
			'name: "User Config"\nmodels:\n  - name: "m"\n',
		);
		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools()).toEqual([]);
	});

	test("ignores user-authored configs lacking CoDev markers", async () => {
		// Claude settings without the ANTHROPIC_DEFAULT_OPUS_MODEL env var that
		// CoDev distinctively writes.
		mkdirSync(join(tempDir, ".claude"), { recursive: true });
		writeFileSync(
			join(tempDir, ".claude", "settings.json"),
			JSON.stringify({ env: { OTHER_KEY: "x" } }),
		);
		// Codex config without the aigateway provider.
		mkdirSync(join(tempDir, ".codex"), { recursive: true });
		writeFileSync(
			join(tempDir, ".codex", "config.toml"),
			'model = "claude-sonnet"\n[model_providers.openai]\nname = "OpenAI"\n',
		);
		// OpenCode config without the aigateway provider.
		mkdirSync(join(tempDir, ".config", "opencode"), { recursive: true });
		writeFileSync(
			join(tempDir, ".config", "opencode", "opencode.json"),
			JSON.stringify({ provider: { other: { name: "Other" } } }),
		);

		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools()).toEqual([]);
	});

	test("returns only the subset that has CoDev markers", async () => {
		seedClaudeWithCodevMarkers();
		// Codex is user-authored (no aigateway).
		mkdirSync(join(tempDir, ".codex"), { recursive: true });
		writeFileSync(
			join(tempDir, ".codex", "config.toml"),
			'model = "x"\n[model_providers.openai]\nname = "OpenAI"\n',
		);
		// OpenCode missing entirely.

		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools()).toEqual(["claude-code"]);
	});

	test("malformed config files are treated as unconfigured", async () => {
		mkdirSync(join(tempDir, ".claude"), { recursive: true });
		writeFileSync(join(tempDir, ".claude", "settings.json"), "not json{{{");
		mkdirSync(join(tempDir, ".codex"), { recursive: true });
		writeFileSync(
			join(tempDir, ".codex", "config.toml"),
			"this is = not [ valid toml",
		);
		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools()).toEqual([]);
	});
});
