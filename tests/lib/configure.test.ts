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
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("bypassClaudeLogin", () => {
	test("creates .claude.json with hasCompletedOnboarding when file does not exist", async () => {
		const { bypassClaudeLogin } = await import("@/lib/configure.js");
		bypassClaudeLogin();

		const filePath = join(tempDir, ".claude.json");
		expect(existsSync(filePath)).toBe(true);

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("adds hasCompletedOnboarding to existing file without it", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }, null, 2));

		const { bypassClaudeLogin } = await import("@/lib/configure.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
		expect(config.someKey).toBe("someValue");
	});

	test("does not overwrite file when hasCompletedOnboarding already set", async () => {
		const filePath = join(tempDir, ".claude.json");
		const original = { hasCompletedOnboarding: true, other: "data" };
		writeFileSync(filePath, JSON.stringify(original, null, 2));

		const { bypassClaudeLogin } = await import("@/lib/configure.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config).toEqual(original);
	});

	test("handles invalid JSON in existing file", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, "not valid json{{{");

		const { bypassClaudeLogin } = await import("@/lib/configure.js");
		bypassClaudeLogin();

		const config = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
	});

	test("does not create a .claude.json.backup", async () => {
		const filePath = join(tempDir, ".claude.json");
		writeFileSync(filePath, JSON.stringify({ someKey: "someValue" }));

		const { bypassClaudeLogin } = await import("@/lib/configure.js");
		bypassClaudeLogin();

		expect(existsSync(`${filePath}.backup`)).toBe(false);
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
			ANTHROPIC_BASE_URL: AI_GATEWAY_URL,
			ANTHROPIC_API_KEY: "sk-abc",
			ANTHROPIC_MODEL: "chosen-model",
			ANTHROPIC_DEFAULT_OPUS_MODEL: "chosen-model",
			ANTHROPIC_DEFAULT_SONNET_MODEL: "chosen-model",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: "chosen-model",
			CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
		});
	});

	test("also runs bypassClaudeLogin (creates .claude.json)", async () => {
		const { configureClaudeCode } = await import("@/lib/configure.js");
		configureClaudeCode({ apiKey: "sk-abc", model: "m" });

		const claudeJson = join(tempDir, ".claude.json");
		expect(existsSync(claudeJson)).toBe(true);
		const config = JSON.parse(readFileSync(claudeJson, "utf-8"));
		expect(config.hasCompletedOnboarding).toBe(true);
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
			AI_GATEWAY_OPENAI_URL,
		);
		expect(config.provider.aigateway.options.apiKey).toBe("sk-xyz");
		expect(config.provider.aigateway.models["chosen-model"].name).toBe(
			"chosen-model",
		);
		// Top-level `model` pins the active default in <provider>/<modelId> form.
		expect(config.model).toBe("aigateway/chosen-model");
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

describe("configureCodex", () => {
	function readCodexToml() {
		return TOML.parse(
			readFileSync(join(tempDir, ".codex", "config.toml"), "utf-8"),
		) as {
			model: string;
			model_provider: string;
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
			AI_GATEWAY_OPENAI_URL,
		);
		expect(config.model_providers.aigateway?.wire_api).toBe("responses");
		expect(config.model_providers.aigateway?.experimental_bearer_token).toBe(
			"sk-codex",
		);
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

describe("configureVscodeContinue", () => {
	function readContinueYaml(): string {
		return readFileSync(join(tempDir, ".continue", "config.yaml"), "utf-8");
	}

	test("creates ~/.continue/config.yaml with CoDev marker when file does not exist", async () => {
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({ apiKey: "sk-vscode", model: "chosen-model" });

		const filePath = join(tempDir, ".continue", "config.yaml");
		expect(existsSync(filePath)).toBe(true);
		const raw = readContinueYaml();
		expect(raw).toContain("CoDev (AI Gateway)");
		// OpenAI-compatible provider entry pinned to the gateway's /v1 endpoint.
		expect(raw).toContain(`provider: "openai"`);
		expect(raw).toContain(`apiBase: "${AI_GATEWAY_OPENAI_URL}"`);
		expect(raw).toContain(`apiKey: "sk-vscode"`);
		expect(raw).toContain(`name: "chosen-model"`);
		expect(raw).toContain(`model: "chosen-model"`);
	});

	test("emits one model entry per fetched model", async () => {
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({
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
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({ apiKey: "sk", model: "solo-model" });

		const raw = readContinueYaml();
		expect(raw.match(/^\s*-\s+name:\s+"solo-model"$/m)).not.toBeNull();
		// No other model entries.
		const matches = raw.match(/^\s*-\s+name:/gm) ?? [];
		expect(matches.length).toBe(1);
	});

	test("appends /v1 to a user-supplied base URL with no v1 suffix", async () => {
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({
			apiKey: "sk",
			baseUrl: "https://example.com",
			model: "m",
		});

		const raw = readContinueYaml();
		expect(raw).toContain(`apiBase: "https://example.com/v1"`);
	});

	test("preserves a base URL that already ends with /v1", async () => {
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({
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

		const { configureVscodeContinue } = await import("@/lib/configure.js");
		const results = configureVscodeContinue({
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

		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({ apiKey: "sk-new", model: "m" });

		expect(readFileSync(backupPath, "utf-8")).toContain("original-user-config");
	});

	test("does not touch ~/.claude.json (VSCode-only install)", async () => {
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		configureVscodeContinue({ apiKey: "sk", model: "m" });

		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
	});

	test("escapes embedded double quotes and backslashes in scalar values", async () => {
		const { configureVscodeContinue } = await import("@/lib/configure.js");
		// API keys can in theory contain any byte; the YAML emitter must not
		// produce a malformed scalar for a key that includes `"` or `\`.
		configureVscodeContinue({
			apiKey: 'sk-with-"quote"-and-\\back',
			model: "m",
		});

		const raw = readContinueYaml();
		expect(raw).toContain(`apiKey: "sk-with-\\"quote\\"-and-\\\\back"`);
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

	test("returns vscode-continue-config for vscode-continue", async () => {
		const { getBackupStatus } = await import("@/lib/configure.js");
		const statuses = getBackupStatus("vscode-continue");
		expect(statuses.map((s) => s.kind)).toEqual(["vscode-continue-config"]);
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
		const result = restoreTool("claude-code");

		expect(result.status).toBe("restored");
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
		const result = restoreTool("opencode");

		expect(result.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(existsSync(livePath)).toBe(true);
	});

	test("returns no-backup status when backup missing", async () => {
		const { restoreTool } = await import("@/lib/configure.js");
		const result = restoreTool("claude-code");

		expect(result.status).toBe("no-backup");
		expect(result.backupPath).toBe(
			join(tempDir, ".claude", "settings.json.backup"),
		);
	});

	test("replaces the live Continue config.yaml with the backup", async () => {
		const dir = join(tempDir, ".continue");
		const livePath = join(dir, "config.yaml");
		const backupPath = `${livePath}.backup`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(livePath, 'name: "live"\n');
		writeFileSync(backupPath, 'name: "backup"\n');

		const { restoreTool } = await import("@/lib/configure.js");
		const result = restoreTool("vscode-continue");

		expect(result.status).toBe("restored");
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
		const result = restoreTool("codex");

		expect(result.status).toBe("restored");
		expect(existsSync(backupPath)).toBe(false);
		expect(readFileSync(livePath, "utf-8")).toContain('marker = "backup"');
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
		expect(result?.kind).toBe("vscode-continue-config");
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

	test("does not create .claude.json (skips bypassClaudeLogin)", async () => {
		const dir = join(tempDir, ".claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), "{}");

		const { backupOnly } = await import("@/lib/configure.js");
		backupOnly("claude-code");

		// Skip path must not write the agent's onboarding bypass — the user
		// explicitly asked CoDev not to touch their config.
		expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
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
					ANTHROPIC_BASE_URL: AI_GATEWAY_URL,
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

	test("detects all four when each tool has CoDev markers", async () => {
		seedClaudeWithCodevMarkers();
		seedCodexWithCodevMarkers();
		seedOpenCodeWithCodevMarkers();
		seedContinueWithCodevMarkers();
		const { detectConfiguredTools } = await import("@/lib/configure.js");
		expect(detectConfiguredTools().sort()).toEqual([
			"claude-code",
			"codex",
			"opencode",
			"vscode-continue",
		]);
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
