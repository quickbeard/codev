import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import { AI_GATEWAY_OPENAI_URL, AI_GATEWAY_URL } from "@/lib/const.js";

export type Tool = "claude-code" | "codex" | "opencode" | "vscode-continue";
export type BackupKind =
	| "claude-settings"
	| "codex-config"
	| "opencode-config"
	| "vscode-continue-config";

export interface BackupStatus {
	kind: BackupKind;
	sourcePath: string;
	backupPath: string;
	hasSource: boolean;
	hasBackup: boolean;
}

export interface ConfigureResult {
	kind: BackupKind;
	sourcePath: string;
	backupPath: string | null;
	// True only when this call actually wrote a new `*.backup` file. False when
	// a pre-existing backup was preserved (or when nothing existed to back up).
	created: boolean;
}

export interface Credentials {
	apiKey: string;
	baseUrl?: string;
	// The chosen default. Required at the configure-time boundary (enforced
	// via `requireModel`); optional in the type so the in-flight install
	// state can carry partial credentials before the model-choice step.
	model?: string;
	// The full list of fetched model IDs. Tools that support an explicit
	// model list (OpenCode today) get every entry; tools with a single
	// model field (Claude Code, Codex) ignore this and use only `model`.
	// Absent ⇒ treat as [model], so older call sites stay valid.
	models?: string[];
}

// Claude Code's ANTHROPIC_BASE_URL is a server root, not an OpenAI-style /v1
// endpoint, so strip a trailing "v1" or "v1/" the user may have entered.
function normalizeClaudeBaseUrl(url: string): string {
	return url.replace(/v1\/?$/, "");
}

// OpenCode's OpenAI-compatible provider expects the /v1 endpoint. Preserve
// any trailing "v1" or "v1/" the user entered; otherwise append "/v1".
function normalizeOpenCodeBaseUrl(url: string): string {
	if (/v1\/?$/.test(url)) return url;
	return url.endsWith("/") ? `${url}v1` : `${url}/v1`;
}

// Fallback model used when the `/v1/models` fetch fails (network error,
// timeout, auth error, or empty response). Install proceeds with this model
// rather than blocking. Base64-encoded to keep the literal name out of the
// shipped source.
export const DEFAULT_MODEL = atob("TWluaU1heA==");

function requireModel(creds: Credentials): string {
	if (!creds.model) {
		throw new Error("Credentials.model is required");
	}
	return creds.model;
}

const CLAUDE_SCHEMA_URL = atob(
	"aHR0cHM6Ly9qc29uLnNjaGVtYXN0b3JlLm9yZy9jbGF1ZGUtY29kZS1zZXR0aW5ncy5qc29u",
);
const CLAUDE_K = {
	schema: atob("JHNjaGVtYQ=="),
	env: atob("ZW52"),
	baseUrl: atob("QU5USFJPUElDX0JBU0VfVVJM"),
	apiKey: atob("QU5USFJPUElDX0FQSV9LRVk="),
	model: atob("QU5USFJPUElDX01PREVM"),
	opus: atob("QU5USFJPUElDX0RFRkFVTFRfT1BVU19NT0RFTA=="),
	sonnet: atob("QU5USFJPUElDX0RFRkFVTFRfU09OTkVUX01PREVM"),
	haiku: atob("QU5USFJPUElDX0RFRkFVTFRfSEFJS1VfTU9ERUw="),
	agentTeams: atob("Q0xBVURFX0NPREVfRVhQRVJJTUVOVEFMX0FHRU5UX1RFQU1T"),
};

const CODEX_K = {
	model: atob("bW9kZWw="),
	modelProvider: atob("bW9kZWxfcHJvdmlkZXI="),
	modelProviders: atob("bW9kZWxfcHJvdmlkZXJz"),
	providerId: atob("YWlnYXRld2F5"),
	name: atob("bmFtZQ=="),
	displayName: atob("QUkgR2F0ZXdheQ=="),
	baseUrl: atob("YmFzZV91cmw="),
	wireApi: atob("d2lyZV9hcGk="),
	wireApiValue: atob("cmVzcG9uc2Vz"),
	bearerToken: atob("ZXhwZXJpbWVudGFsX2JlYXJlcl90b2tlbg=="),
};

const OPENCODE_SCHEMA_URL = atob(
	"aHR0cHM6Ly9vcGVuY29kZS5haS9jb25maWcuanNvbg==",
);
const OPENCODE_K = {
	schema: atob("JHNjaGVtYQ=="),
	model: atob("bW9kZWw="),
	provider: atob("cHJvdmlkZXI="),
	providerKey: atob("YWlnYXRld2F5"),
	npm: atob("bnBt"),
	npmPkg: atob("QGFpLXNkay9vcGVuYWktY29tcGF0aWJsZQ=="),
	name: atob("bmFtZQ=="),
	displayName: atob("QUkgR2F0ZXdheQ=="),
	options: atob("b3B0aW9ucw=="),
	baseURL: atob("YmFzZVVSTA=="),
	apiKey: atob("YXBpS2V5"),
	models: atob("bW9kZWxz"),
};

// Continue (continue.continue VS Code extension) reads ~/.continue/config.yaml.
// We write the OpenAI-compatible provider shape: each fetched model becomes a
// top-level entry in `models:`, all sharing the same apiBase + apiKey. The
// top-level `name` field doubles as the marker `detectConfiguredTools()` uses
// to recognize CoDev-written Continue configs.
const CONTINUE_K = {
	name: atob("bmFtZQ=="),
	version: atob("dmVyc2lvbg=="),
	schema: atob("c2NoZW1h"),
	schemaValue: atob("djE="),
	models: atob("bW9kZWxz"),
	provider: atob("cHJvdmlkZXI="),
	providerValue: atob("b3BlbmFp"),
	model: atob("bW9kZWw="),
	apiBase: atob("YXBpQmFzZQ=="),
	apiKey: atob("YXBpS2V5"),
	configName: atob("Q29EZXYgKEFJIEdhdGV3YXkp"),
	configVersion: atob("MC4wLjE="),
};

function sourcePathOf(kind: BackupKind): string {
	switch (kind) {
		case "claude-settings":
			return join(homedir(), ".claude", "settings.json");
		case "codex-config":
			return join(homedir(), ".codex", "config.toml");
		case "opencode-config":
			return join(homedir(), ".config", "opencode", "opencode.json");
		case "vscode-continue-config":
			return join(homedir(), ".continue", "config.yaml");
	}
}

function statusFor(kind: BackupKind): BackupStatus {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	return {
		kind,
		sourcePath,
		backupPath,
		hasSource: existsSync(sourcePath),
		hasBackup: existsSync(backupPath),
	};
}

export function getBackupStatus(tool: Tool): BackupStatus[] {
	return [statusFor(kindForTool(tool))];
}

// Detect which AI tools currently have a CoDev-managed config on disk. Used
// by `codev model` to know whose configs to rewrite when the user switches
// the default model. Each marker is something CoDev distinctly writes — the
// `aigateway` provider id (codex/opencode) or `ANTHROPIC_DEFAULT_OPUS_MODEL`
// (claude-code) — none of which would appear in a user-authored config.
export function detectConfiguredTools(): Tool[] {
	const tools: Tool[] = [];
	if (isCodevClaudeConfig()) tools.push("claude-code");
	if (isCodevCodexConfig()) tools.push("codex");
	if (isCodevOpenCodeConfig()) tools.push("opencode");
	if (isCodevContinueConfig()) tools.push("vscode-continue");
	return tools;
}

function hasNestedKey(obj: unknown, outer: string, inner: string): boolean {
	if (!obj || typeof obj !== "object") return false;
	const next = (obj as Record<string, unknown>)[outer];
	if (!next || typeof next !== "object") return false;
	return inner in (next as Record<string, unknown>);
}

function isCodevClaudeConfig(): boolean {
	const path = sourcePathOf("claude-settings");
	if (!existsSync(path)) return false;
	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return hasNestedKey(config, CLAUDE_K.env, CLAUDE_K.opus);
	} catch {
		return false;
	}
}

function isCodevCodexConfig(): boolean {
	const path = sourcePathOf("codex-config");
	if (!existsSync(path)) return false;
	try {
		const config = TOML.parse(readFileSync(path, "utf-8")) as unknown;
		return hasNestedKey(config, CODEX_K.modelProviders, CODEX_K.providerId);
	} catch {
		return false;
	}
}

function isCodevOpenCodeConfig(): boolean {
	const path = sourcePathOf("opencode-config");
	if (!existsSync(path)) return false;
	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return hasNestedKey(config, OPENCODE_K.provider, OPENCODE_K.providerKey);
	} catch {
		return false;
	}
}

// Continue's config is YAML; pulling in a YAML parser just for one substring
// check would be overkill. The top-level `name:` we emit is verbatim and
// distinctive, so a substring search on the raw file is sufficient.
function isCodevContinueConfig(): boolean {
	const path = sourcePathOf("vscode-continue-config");
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf-8");
		return raw.includes(CONTINUE_K.configName);
	} catch {
		return false;
	}
}

function kindForTool(tool: Tool): BackupKind {
	switch (tool) {
		case "claude-code":
			return "claude-settings";
		case "codex":
			return "codex-config";
		case "opencode":
			return "opencode-config";
		case "vscode-continue":
			return "vscode-continue-config";
	}
}

// Create the *.backup snapshot for `tool` without writing CoDev's config.
// Used by the install flow's "Skip configuration" path.
export function backupOnly(tool: Tool): ConfigureResult[] {
	const kind = kindForTool(tool);
	const { path, created } = ensureBackup(kind);
	return [{ kind, sourcePath: sourcePathOf(kind), backupPath: path, created }];
}

interface BackupOutcome {
	path: string | null;
	created: boolean;
}

function ensureBackup(kind: BackupKind): BackupOutcome {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;
	if (!existsSync(sourcePath)) {
		return existsSync(backupPath)
			? { path: backupPath, created: false }
			: { path: null, created: false };
	}
	// Preserve any pre-existing backup — assume it's the user's original
	// pre-codev state and should not be clobbered by later runs.
	if (existsSync(backupPath)) {
		return { path: backupPath, created: false };
	}
	copyFileSync(sourcePath, backupPath);
	return { path: backupPath, created: true };
}

function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function writeJson(path: string, data: unknown) {
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

function writeToml(path: string, data: TOML.JsonMap) {
	writeFileSync(path, TOML.stringify(data), { mode: 0o600 });
	chmodSync(path, 0o600);
}

// Always-double-quote YAML scalar. Defensive: api keys can contain any byte,
// model IDs occasionally contain colons or slashes — double quotes are the
// only YAML scalar form that requires no further character-class reasoning,
// just escape `\` and `"`.
function yamlScalar(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function writeText(path: string, contents: string) {
	writeFileSync(path, contents, { mode: 0o600 });
	chmodSync(path, 0o600);
}

export function bypassClaudeLogin(): void {
	const claudeJsonPath = join(homedir(), ".claude.json");
	const config = readJson(claudeJsonPath);
	if (!config.hasCompletedOnboarding) {
		config.hasCompletedOnboarding = true;
		writeJson(claudeJsonPath, config);
	}
}

export function configureClaudeCode(creds: Credentials): ConfigureResult[] {
	bypassClaudeLogin();

	const { path: backupPath, created } = ensureBackup("claude-settings");
	const sourcePath = sourcePathOf("claude-settings");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeClaudeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_URL;
	const model = requireModel(creds);

	writeJson(sourcePath, {
		[CLAUDE_K.schema]: CLAUDE_SCHEMA_URL,
		[CLAUDE_K.env]: {
			[CLAUDE_K.baseUrl]: baseUrl,
			[CLAUDE_K.apiKey]: creds.apiKey,
			[CLAUDE_K.model]: model,
			[CLAUDE_K.opus]: model,
			[CLAUDE_K.sonnet]: model,
			[CLAUDE_K.haiku]: model,
			[CLAUDE_K.agentTeams]: "1",
		},
	});

	return [{ kind: "claude-settings", sourcePath, backupPath, created }];
}

export type RestoreStatus = "restored" | "no-backup";

export interface RestoreResult {
	status: RestoreStatus;
	sourcePath: string;
	backupPath: string;
}

export function restoreTool(tool: Tool): RestoreResult {
	const kind = kindForTool(tool);
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;

	if (!existsSync(backupPath)) {
		return { status: "no-backup", sourcePath, backupPath };
	}

	rmSync(sourcePath, { force: true });
	renameSync(backupPath, sourcePath);
	return { status: "restored", sourcePath, backupPath };
}

export function configureCodex(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("codex-config");
	const sourcePath = sourcePathOf("codex-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL;
	const model = requireModel(creds);

	writeToml(sourcePath, {
		[CODEX_K.model]: model,
		[CODEX_K.modelProvider]: CODEX_K.providerId,
		[CODEX_K.modelProviders]: {
			[CODEX_K.providerId]: {
				[CODEX_K.name]: CODEX_K.displayName,
				[CODEX_K.baseUrl]: baseUrl,
				[CODEX_K.wireApi]: CODEX_K.wireApiValue,
				[CODEX_K.bearerToken]: creds.apiKey,
			},
		},
	});

	return [{ kind: "codex-config", sourcePath, backupPath, created }];
}

export function configureVscodeContinue(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("vscode-continue-config");
	const sourcePath = sourcePathOf("vscode-continue-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	// Continue's `openai` provider expects the OpenAI-compatible /v1 endpoint —
	// same normalization as Codex/OpenCode.
	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL;
	const defaultModel = requireModel(creds);
	const allModels =
		creds.models && creds.models.length > 0 ? creds.models : [defaultModel];

	const lines: string[] = [];
	lines.push(`${CONTINUE_K.name}: ${yamlScalar(CONTINUE_K.configName)}`);
	lines.push(`${CONTINUE_K.version}: ${yamlScalar(CONTINUE_K.configVersion)}`);
	lines.push(`${CONTINUE_K.schema}: ${yamlScalar(CONTINUE_K.schemaValue)}`);
	lines.push(`${CONTINUE_K.models}:`);
	for (const id of allModels) {
		lines.push(`  - ${CONTINUE_K.name}: ${yamlScalar(id)}`);
		lines.push(
			`    ${CONTINUE_K.provider}: ${yamlScalar(CONTINUE_K.providerValue)}`,
		);
		lines.push(`    ${CONTINUE_K.model}: ${yamlScalar(id)}`);
		lines.push(`    ${CONTINUE_K.apiBase}: ${yamlScalar(baseUrl)}`);
		lines.push(`    ${CONTINUE_K.apiKey}: ${yamlScalar(creds.apiKey)}`);
	}
	writeText(sourcePath, `${lines.join("\n")}\n`);

	return [{ kind: "vscode-continue-config", sourcePath, backupPath, created }];
}

export function configureOpenCode(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("opencode-config");
	const sourcePath = sourcePathOf("opencode-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL;
	const defaultModel = requireModel(creds);
	// Fall back to [defaultModel] when `models` is unset so callers that don't
	// know about the list (e.g. older fixtures, the fallback path with no
	// fetched list) still produce a valid one-entry map.
	const allModels =
		creds.models && creds.models.length > 0 ? creds.models : [defaultModel];

	const modelsMap = Object.fromEntries(
		allModels.map((id) => [id, { [OPENCODE_K.name]: id }]),
	);

	writeJson(sourcePath, {
		[OPENCODE_K.schema]: OPENCODE_SCHEMA_URL,
		// Top-level `model` pins the initial active model OpenCode uses on
		// launch. Format is `<provider>/<modelId>` per OpenCode's schema.
		[OPENCODE_K.model]: `${OPENCODE_K.providerKey}/${defaultModel}`,
		[OPENCODE_K.provider]: {
			[OPENCODE_K.providerKey]: {
				[OPENCODE_K.npm]: OPENCODE_K.npmPkg,
				[OPENCODE_K.name]: OPENCODE_K.displayName,
				[OPENCODE_K.options]: {
					[OPENCODE_K.baseURL]: baseUrl,
					[OPENCODE_K.apiKey]: creds.apiKey,
				},
				[OPENCODE_K.models]: modelsMap,
			},
		},
	});

	return [{ kind: "opencode-config", sourcePath, backupPath, created }];
}
