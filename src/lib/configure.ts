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
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	CLAUDE_AUTO_COMPACT_WINDOW,
	CLAUDE_AUTOCOMPACT_PCT,
} from "@/lib/const.js";
import type { Agent } from "@/providers/types.js";

export type Tool =
	| "claude-code"
	| "codex"
	| "opencode"
	| "vscode-claude-code"
	| "jetbrains-claude-code"
	| "vscode-continue"
	| "jetbrains-continue";
export type BackupKind =
	| "claude-settings"
	| "claude-json"
	| "claude-credentials"
	| "codex-config"
	| "opencode-config"
	| "continue-config";

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
	autoCompactWindow: atob("Q0xBVURFX0NPREVfQVVUT19DT01QQUNUX1dJTkRPVw=="),
	autoCompactPct: atob("Q0xBVURFX0FVVE9DT01QQUNUX1BDVF9PVkVSUklERQ=="),
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

// The base URL CoDev writes to each tool's config. Read back at export time so
// the session comment (markdown.ts) can embed base_url, enabling the worker to
// determine internal vs external model usage without any env-var timing tricks.
//
// Three patterns, one per tool:
//   Claude Code → settings.json → env.ANTHROPIC_BASE_URL
//   Codex       → config.toml   → model_providers.aigateway.base_url
//   OpenCode    → opencode.json → provider.aigateway.options.baseURL
//
// Returns undefined when the file is absent, not CoDev-managed, or unreadable.

export interface AgentConfigResult {
	baseUrl?: string;
}

export function readAgentConfig(agent: Agent): AgentConfigResult {
	switch (agent) {
		case "claude-code":
			return readClaudeCodeConfig();
		case "codex":
			return readCodexConfig();
		case "opencode":
			return readOpenCodeConfig();
	}
}

// Internal helpers follow. All throw on malformed JSON/TOML so callers that
// encounter genuinely old/corrupt configs see a clear error rather than silently
// returning undefined.

function readClaudeCodeConfig(): AgentConfigResult {
	const path = sourcePathOf("claude-settings");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		// Guard: skip files CoDev did not write (no ANTHROPIC_DEFAULT_OPUS_MODEL).
		if (!hasNestedKey(raw, CLAUDE_K.env, CLAUDE_K.opus)) return {};
		const env = (raw as Record<string, unknown>)[CLAUDE_K.env] as Record<
			string,
			unknown
		>;
		return {
			baseUrl: (env[CLAUDE_K.baseUrl] as string) || undefined,
		};
	} catch {
		return {};
	}
}

function readCodexConfig(): AgentConfigResult {
	const path = sourcePathOf("codex-config");
	if (!existsSync(path)) return {};
	try {
		const raw = TOML.parse(readFileSync(path, "utf-8")) as unknown;
		// Guard: skip non-CoDev configs (no aigateway provider).
		if (!hasNestedKey(raw, CODEX_K.modelProviders, CODEX_K.providerId))
			return {};
		const r = raw as Record<string, unknown>;
		const providers =
			(r[CODEX_K.modelProviders] as Record<string, unknown>) || {};
		const aigateway =
			(providers[CODEX_K.providerId as string] as Record<string, unknown>) ||
			{};
		return {
			baseUrl: (aigateway[CODEX_K.baseUrl as string] as string) || undefined,
		};
	} catch {
		return {};
	}
}

function readOpenCodeConfig(): AgentConfigResult {
	const path = sourcePathOf("opencode-config");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		// Guard: skip non-CoDev configs (no aigateway provider).
		if (!hasNestedKey(raw, OPENCODE_K.provider, OPENCODE_K.providerKey))
			return {};
		const r = raw as Record<string, unknown>;
		const provider = (r[OPENCODE_K.provider] as Record<string, unknown>) || {};
		const aigateway =
			(provider[OPENCODE_K.providerKey as string] as Record<string, unknown>) ||
			{};
		const options =
			(aigateway[OPENCODE_K.options as string] as Record<string, unknown>) ||
			{};
		return {
			baseUrl: (options[OPENCODE_K.baseURL as string] as string) || undefined,
		};
	} catch {
		return {};
	}
}

// Continue reads ~/.continue/config.yaml from a single shared location across
// editors (VS Code + JetBrains both load this file). We write the OpenAI-
// compatible provider shape: each fetched model becomes a top-level entry in
// `models:`, all sharing the same apiBase + apiKey. The top-level `name` field
// doubles as the marker `detectConfiguredTools()` uses to recognize CoDev-
// written Continue configs.
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
		case "claude-json":
			return join(homedir(), ".claude.json");
		case "claude-credentials":
			return join(homedir(), ".claude", ".credentials.json");
		case "codex-config":
			return join(homedir(), ".codex", "config.toml");
		case "opencode-config":
			return join(homedir(), ".config", "opencode", "opencode.json");
		case "continue-config":
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
//
// Continue's config file is shared across editors (VS Code + JetBrains both
// read the same ~/.continue/config.yaml), so when the marker is present we
// return `vscode-continue` as the canonical pointer rather than enumerating
// both editor tools. That keeps `codev model` rewriting the YAML once
// instead of twice; the resulting file is correct for both editors.
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
	const path = sourcePathOf("continue-config");
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf-8");
		return raw.includes(CONTINUE_K.configName);
	} catch {
		return false;
	}
}

// Tools that share a config file map to the same BackupKind. Continue's two
// editor variants share ~/.continue/config.yaml; the Claude Code CLI and its
// two extension variants share ~/.claude/settings.json. Callers that iterate
// `tools` to write configs should dedupe by kind so each shared file isn't
// written more than once.
export function kindForTool(tool: Tool): BackupKind {
	switch (tool) {
		case "claude-code":
		case "vscode-claude-code":
		case "jetbrains-claude-code":
			return "claude-settings";
		case "codex":
			return "codex-config";
		case "opencode":
			return "opencode-config";
		case "vscode-continue":
		case "jetbrains-continue":
			return "continue-config";
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

// Reset Claude Code's auth state so a fresh install starts cleanly under
// CoDev's gateway credentials. Two files are handled in addition to the
// settings.json snapshot taken by `configureClaudeCode`:
//
//   - `~/.claude.json` — onboarding/state file. Backed up if present, then
//     replaced with `{hasCompletedOnboarding: true}` so the CLI skips its
//     first-run wizard. (Pre-existing fields are *not* preserved; the user's
//     original is reachable via `*.backup`.)
//   - `~/.claude/.credentials.json` — CLI-managed session credentials. Backed
//     up if present, then removed so the CLI cannot reuse stale auth that
//     would conflict with the gateway API key in settings.json.
//
// Called once from `InstallApp.handleInstallDone` when any Claude tool
// (CLI or either extension) survives the install step. Returns the two
// `ConfigureResult`s so callers may log/report; the install flow currently
// ignores the return (silent operation per design).
// Back up ~/.claude.json and ~/.claude/.credentials.json without modifying
// either. Used by the install flow's finalize Phase on the "Skip
// configuration" path; resetClaudeAuth() calls this internally before its
// destructive work, so a caller that runs backupClaudeAuth() first and
// later calls resetClaudeAuth() will see the second ensureBackup() preserve
// the backup created on the first pass.
export function backupClaudeAuth(): ConfigureResult[] {
	const results: ConfigureResult[] = [];

	const jsonSource = sourcePathOf("claude-json");
	const { path: jsonBackup, created: jsonCreated } =
		ensureBackup("claude-json");
	results.push({
		kind: "claude-json",
		sourcePath: jsonSource,
		backupPath: jsonBackup,
		created: jsonCreated,
	});

	const credSource = sourcePathOf("claude-credentials");
	const { path: credBackup, created: credCreated } =
		ensureBackup("claude-credentials");
	results.push({
		kind: "claude-credentials",
		sourcePath: credSource,
		backupPath: credBackup,
		created: credCreated,
	});

	return results;
}

export function resetClaudeAuth(): ConfigureResult[] {
	const results = backupClaudeAuth();

	const jsonSource = sourcePathOf("claude-json");
	mkdirSync(dirname(jsonSource), { recursive: true });
	writeJson(jsonSource, { hasCompletedOnboarding: true });

	const credSource = sourcePathOf("claude-credentials");
	if (existsSync(credSource)) {
		rmSync(credSource, { force: true });
	}

	return results;
}

export function configureClaudeCode(creds: Credentials): ConfigureResult[] {
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
			[CLAUDE_K.autoCompactWindow]: CLAUDE_AUTO_COMPACT_WINDOW,
			[CLAUDE_K.autoCompactPct]: CLAUDE_AUTOCOMPACT_PCT,
		},
	});

	return [{ kind: "claude-settings", sourcePath, backupPath, created }];
}

export type RestoreStatus = "restored" | "deleted-live" | "noop";

export interface RestoreResult {
	status: RestoreStatus;
	sourcePath: string;
	backupPath: string;
}

// "Make this file look pre-CoDev." Three terminal states:
//   - backup present → swap it over the live file (the user's pre-CoDev
//     state is reinstated).
//   - no backup, but a live file exists → delete the live file. CoDev only
//     skips the backup step when there was nothing to back up in the first
//     place, so any live file here is post-CoDev (CoDev-authored, or created
//     by the tool after CoDev wiped it); removing it lands the user at
//     "no file", which IS the pre-CoDev state.
//   - neither file exists → noop; already at pre-CoDev state.
function restoreKind(kind: BackupKind): RestoreResult {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;

	if (existsSync(backupPath)) {
		rmSync(sourcePath, { force: true });
		renameSync(backupPath, sourcePath);
		return { status: "restored", sourcePath, backupPath };
	}

	if (existsSync(sourcePath)) {
		rmSync(sourcePath, { force: true });
		return { status: "deleted-live", sourcePath, backupPath };
	}

	return { status: "noop", sourcePath, backupPath };
}

// Claude tools own three files (settings.json, .claude.json,
// .credentials.json), so `restoreTool` returns an array. Single-file tools
// return a length-1 array. Callers iterate and aggregate per-tool status.
const CLAUDE_RESTORE_KINDS: BackupKind[] = [
	"claude-settings",
	"claude-json",
	"claude-credentials",
];

export function restoreTool(tool: Tool): RestoreResult[] {
	if (
		tool === "claude-code" ||
		tool === "vscode-claude-code" ||
		tool === "jetbrains-claude-code"
	) {
		return CLAUDE_RESTORE_KINDS.map(restoreKind);
	}
	return [restoreKind(kindForTool(tool))];
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

export function configureContinue(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("continue-config");
	const sourcePath = sourcePathOf("continue-config");
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

	return [{ kind: "continue-config", sourcePath, backupPath, created }];
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
