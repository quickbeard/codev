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
import { type ParseError, parse } from "jsonc-parser";
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	GATEWAY_COMPACT_PCT,
	GATEWAY_COMPACT_RESERVED,
	GATEWAY_COMPACT_TRIGGER,
	GATEWAY_CONTEXT_WINDOW,
	GATEWAY_MAX_OUTPUT_TOKENS,
} from "@/lib/const.js";
import { logInfo } from "@/lib/log.js";
import { codevProviderIds, resolveProvider } from "@/lib/provider.js";
import type { Agent } from "@/providers/types.js";

export type Tool =
	| "claude-code"
	| "codex"
	| "opencode"
	| "codev-code"
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
	| "codev-code-config"
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
	// The provider the user named on the manual path. Absent ⇒ SSO-issued key,
	// which gets the built-in netGate identity (lib/provider.ts).
	providerId?: string;
	providerName?: string;
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
	modelContextWindow: atob("bW9kZWxfY29udGV4dF93aW5kb3c="),
	autoCompactTokenLimit: atob("bW9kZWxfYXV0b19jb21wYWN0X3Rva2VuX2xpbWl0"),
	modelProviders: atob("bW9kZWxfcHJvdmlkZXJz"),
	name: atob("bmFtZQ=="),
	baseUrl: atob("YmFzZV91cmw="),
	wireApi: atob("d2lyZV9hcGk="),
	wireApiValue: atob("cmVzcG9uc2Vz"),
	bearerToken: atob("ZXhwZXJpbWVudGFsX2JlYXJlcl90b2tlbg=="),
};

// Exported for lib/codegraph.ts: the fork keeps upstream's schema URL (its
// DIVERGENCES list marks it NOT renamed), and the CoDev Code MCP shim seeds
// the same $schema stub the agent itself writes on first run.
export const OPENCODE_SCHEMA_URL = atob(
	"aHR0cHM6Ly9vcGVuY29kZS5haS9jb25maWcuanNvbg==",
);
const OPENCODE_K = {
	schema: atob("JHNjaGVtYQ=="),
	mcp: atob("bWNw"),
	model: atob("bW9kZWw="),
	provider: atob("cHJvdmlkZXI="),
	npm: atob("bnBt"),
	npmPkg: atob("QGFpLXNkay9vcGVuYWktY29tcGF0aWJsZQ=="),
	name: atob("bmFtZQ=="),
	options: atob("b3B0aW9ucw=="),
	baseURL: atob("YmFzZVVSTA=="),
	apiKey: atob("YXBpS2V5"),
	models: atob("bW9kZWxz"),
	attachment: atob("YXR0YWNobWVudA=="),
	modalities: atob("bW9kYWxpdGllcw=="),
	input: atob("aW5wdXQ="),
	text: atob("dGV4dA=="),
	image: atob("aW1hZ2U="),
	limit: atob("bGltaXQ="),
	context: atob("Y29udGV4dA=="),
	output: atob("b3V0cHV0"),
	compaction: atob("Y29tcGFjdGlvbg=="),
	auto: atob("YXV0bw=="),
	reserved: atob("cmVzZXJ2ZWQ="),
};

// The base URL CoDev writes to each tool's config. Read back at export time so
// the session comment (markdown.ts) can embed base_url, enabling the worker to
// determine internal vs external model usage without any env-var timing tricks.
//
// Three patterns, one per tool:
//   Claude Code → settings.json → env.ANTHROPIC_BASE_URL
//   Codex       → config.toml   → model_providers.<provider>.base_url
//   OpenCode    → opencode.json → provider.<provider>.options.baseURL
//
// <provider> is the netGate default for SSO-issued keys, or the id derived from
// the name the user typed on the manual path — so it's resolved at read time
// against codevProviderIds() rather than a fixed key.
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
			return readOpenCodeConfig("opencode-config");
		case "codev-code":
			return readOpenCodeConfig("codev-code-config");
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
	} catch (e) {
		throw new Error(`Failed to parse Claude Code config at ${path}: ${e}`);
	}
}

function readCodexConfig(): AgentConfigResult {
	const path = sourcePathOf("codex-config");
	if (!existsSync(path)) return {};
	try {
		const raw = TOML.parse(readFileSync(path, "utf-8")) as unknown;
		// Guard: skip non-CoDev configs (no provider we recognize).
		const providerId = firstNestedKey(
			raw,
			CODEX_K.modelProviders,
			codevProviderIds(),
		);
		if (!providerId) return {};
		const r = raw as Record<string, unknown>;
		const providers =
			(r[CODEX_K.modelProviders] as Record<string, unknown>) || {};
		const gateway = (providers[providerId] as Record<string, unknown>) || {};
		return {
			baseUrl: (gateway[CODEX_K.baseUrl as string] as string) || undefined,
		};
	} catch (e) {
		throw new Error(`Failed to parse Codex config at ${path}: ${e}`);
	}
}

// Both agents accept .json and .jsonc, and either config may legitimately be a
// .jsonc (see openCodeConfigPath). Parse the superset so a comment or a trailing
// comma can't throw — matching how the agents themselves read it. Still throws
// on genuinely malformed input, per the contract above.
function parseJsonc(text: string): unknown {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) throw new Error("invalid JSON/JSONC");
	return value;
}

// Shared by opencode and codev-code — the fork reads the same config shape, just
// from ~/.config/codev/codev.json(c) instead of ~/.config/opencode/opencode.json.
function readOpenCodeConfig(
	kind: "opencode-config" | "codev-code-config",
): AgentConfigResult {
	const path = sourcePathOf(kind);
	if (!existsSync(path)) return {};
	try {
		const raw = parseJsonc(readFileSync(path, "utf-8"));
		// Guard: skip non-CoDev configs (no provider we recognize).
		const providerId = firstNestedKey(
			raw,
			OPENCODE_K.provider,
			codevProviderIds(),
		);
		if (!providerId) return {};
		const r = raw as Record<string, unknown>;
		const provider = (r[OPENCODE_K.provider] as Record<string, unknown>) || {};
		const gateway = (provider[providerId] as Record<string, unknown>) || {};
		const options =
			(gateway[OPENCODE_K.options as string] as Record<string, unknown>) || {};
		return {
			baseUrl: (options[OPENCODE_K.baseURL as string] as string) || undefined,
		};
	} catch (e) {
		throw new Error(`Failed to parse OpenCode config at ${path}: ${e}`);
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
	// The config title is `CoDev (<provider name>)`, so only the prefix is
	// stable — that prefix is what isCodevContinueConfig matches on.
	configNamePrefix: atob("Q29EZXYgKA=="),
	configVersion: atob("MC4wLjE="),
};

function continueConfigName(providerName: string): string {
	return `${CONTINUE_K.configNamePrefix}${providerName})`;
}

// OpenCode and the codev-code fork share one config loader, so they share this
// hazard: each reads *both* `<base>.json` and `<base>.jsonc` from its config
// dir and deep-merges them, json first, jsonc second — so a jsonc silently wins
// leaf-by-leaf over anything we write to the json.
//
// Their own writers go through the loader's `globalConfigFile()`, which prefers
// .jsonc and *creates* one when no config exists — upstream seeds a `$schema`
// stub on any default run, and `codev configure` patches into whatever it picks.
// A user who launches the agent before `codevhub install` therefore already has
// a jsonc waiting to shadow us. Target the same file the agent would, so exactly
// one gateway block exists.
//
// The order matters, and each rule earns its place:
//  1. A `*.backup` pins the file we already configured. Without this, a jsonc
//     appearing after configure would send restore to the wrong candidate and
//     strand the backup forever.
//  2. An existing jsonc is the agent's write target, and would shadow us.
//  3. Otherwise `<base>.json` — which also keeps the agent from auto-seeding a
//     jsonc later, since `globalConfigFile()` finds `<base>.json` first and
//     leaves well enough alone.
//
// Upstream lists a third candidate, `config.json`, that we deliberately never
// target: it is merged *first*, i.e. lowest priority, so writing there would
// leave us shadowed by both of the others.
function openCodeConfigPath(dir: string, base: string): string {
	const jsonc = join(dir, `${base}.jsonc`);
	const json = join(dir, `${base}.json`);
	for (const candidate of [jsonc, json]) {
		if (existsSync(`${candidate}.backup`)) return candidate;
	}
	return existsSync(jsonc) ? jsonc : json;
}

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
			return openCodeConfigPath(
				join(homedir(), ".config", "opencode"),
				"opencode",
			);
		// The fork renamed both halves of upstream's path: the XDG app dir (its
		// `Global.Path` constant is "codev") and the config basename. Neither old
		// name is read anymore — the fork dropped the fallback.
		case "codev-code-config":
			return openCodeConfigPath(join(homedir(), ".config", "codev"), "codev");
		case "continue-config":
			return join(homedir(), ".continue", "config.yaml");
	}
}

// The one config file CoDev Code reads that CoDev also writes. Exported for
// lib/codegraph.ts's MCP shim and lib/remove.ts's unwire, so all three writers
// resolve the same `.jsonc`-vs-`.json` candidate (see openCodeConfigPath) and
// never shadow each other.
export function codevCodeConfigPath(): string {
	return sourcePathOf("codev-code-config");
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
// by `codevhub model` to know whose configs to rewrite when the user switches
// the default model. Each marker is something CoDev distinctly writes — one of
// the known provider ids (codex/opencode, see codevProviderIds) or
// `ANTHROPIC_DEFAULT_OPUS_MODEL` (claude-code) — none of which would appear in
// a user-authored config.
//
// Continue's config file is shared across editors (VS Code + JetBrains both
// read the same ~/.continue/config.yaml), so when the marker is present we
// return `vscode-continue` as the canonical pointer rather than enumerating
// both editor tools. That keeps `codevhub model` rewriting the YAML once
// instead of twice; the resulting file is correct for both editors.
export function detectConfiguredTools(): Tool[] {
	const tools: Tool[] = [];
	if (isCodevClaudeConfig()) tools.push("claude-code");
	if (isCodevCodexConfig()) tools.push("codex");
	if (isCodevOpenCodeConfig("opencode-config")) tools.push("opencode");
	if (isCodevOpenCodeConfig("codev-code-config")) tools.push("codev-code");
	if (isCodevContinueConfig()) tools.push("vscode-continue");
	return tools;
}

function hasNestedKey(obj: unknown, outer: string, inner: string): boolean {
	if (!obj || typeof obj !== "object") return false;
	const next = (obj as Record<string, unknown>)[outer];
	if (!next || typeof next !== "object") return false;
	return inner in (next as Record<string, unknown>);
}

// Like hasNestedKey, but for the provider maps, whose key is no longer a single
// constant: returns the first candidate id present under `outer`, or null.
// Candidates are ordered most-specific-first (the saved id, then the built-ins),
// so a config carrying both a custom and a legacy entry resolves to the custom.
function firstNestedKey(
	obj: unknown,
	outer: string,
	candidates: string[],
): string | null {
	if (!obj || typeof obj !== "object") return null;
	const next = (obj as Record<string, unknown>)[outer];
	if (!next || typeof next !== "object") return null;
	const map = next as Record<string, unknown>;
	return candidates.find((id) => id in map) ?? null;
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
		return (
			firstNestedKey(config, CODEX_K.modelProviders, codevProviderIds()) !==
			null
		);
	} catch {
		return false;
	}
}

function isCodevOpenCodeConfig(
	kind: "opencode-config" | "codev-code-config",
): boolean {
	const path = sourcePathOf(kind);
	if (!existsSync(path)) return false;
	try {
		const config = parseJsonc(readFileSync(path, "utf-8"));
		return (
			firstNestedKey(config, OPENCODE_K.provider, codevProviderIds()) !== null
		);
	} catch {
		return false;
	}
}

// Continue's config is YAML; pulling in a YAML parser just for one substring
// check would be overkill. The top-level `name:` we emit ends in the provider
// name, so only its prefix is fixed — still distinctive enough that a substring
// search on the raw file is sufficient.
function isCodevContinueConfig(): boolean {
	const path = sourcePathOf("continue-config");
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf-8");
		return raw.includes(CONTINUE_K.configNamePrefix);
	} catch {
		return false;
	}
}

// ~/.claude.json has no CoDev-specific marker key — `resetClaudeAuth` writes it
// as exactly `{hasCompletedOnboarding: true}` to skip the CLI's first-run
// wizard. That whole-file shape *is* the marker: Claude Code's own
// ~/.claude.json accumulates real user state (projects, history, mcpServers),
// so anything beyond the single onboarding key belongs to the user, not us.
function isCodevClaudeJsonStub(): boolean {
	const path = sourcePathOf("claude-json");
	if (!existsSync(path)) return false;
	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!config || typeof config !== "object" || Array.isArray(config)) {
			return false;
		}
		const keys = Object.keys(config);
		return (
			keys.length === 1 &&
			(config as Record<string, unknown>).hasCompletedOnboarding === true
		);
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
		case "codev-code":
			return "codev-code-config";
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
		: AI_GATEWAY_URL();
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
			// Env-var values are strings; the shared window/percentage are numeric.
			[CLAUDE_K.autoCompactWindow]: String(GATEWAY_CONTEXT_WINDOW),
			[CLAUDE_K.autoCompactPct]: String(GATEWAY_COMPACT_PCT),
		},
	});

	return [{ kind: "claude-settings", sourcePath, backupPath, created }];
}

// Does the live file at `kind` look like something CoDev wrote? Gates the
// destructive branch of `restoreKind`, so a `false` must always mean "leave it
// alone". Each detector re-derives its own path via `sourcePathOf` and answers
// `false` for a missing or unparseable file, which is the conservative default
// we want: a config we can't attribute is one we don't delete.
//
// The two auth files have no marker key of their own:
//   - `claude-json` — matched by whole-file shape (see isCodevClaudeJsonStub).
//   - `claude-credentials` — CoDev never *writes* this file, only removes it.
//     So a live one with no backup can only be a login that happened after
//     CoDev configured Claude; it's ours to clear. Worst case the user
//     re-authenticates — no data is lost.
//
// Deliberately no cross-kind inference (e.g. reading settings.json to decide
// the credentials' fate): `restoreTool` restores claude-settings *first*, which
// erases that marker, so the answer would depend on iteration order.
function isCodevAuthored(kind: BackupKind): boolean {
	switch (kind) {
		case "claude-settings":
			return isCodevClaudeConfig();
		case "claude-json":
			return isCodevClaudeJsonStub();
		case "claude-credentials":
			return true;
		case "codex-config":
			return isCodevCodexConfig();
		case "opencode-config":
		case "codev-code-config":
			return isCodevOpenCodeConfig(kind);
		case "continue-config":
			return isCodevContinueConfig();
	}
}

export type RestoreStatus = "restored" | "deleted" | "kept-live" | "noop";

export interface RestoreResult {
	status: RestoreStatus;
	sourcePath: string;
	backupPath: string;
	// Set on `deleted` only, and only when the file was removed *despite* not
	// looking CoDev-authored — i.e. `force` overrode the gate. Lets callers say
	// what actually happened instead of claiming CoDev wrote the file.
	forced?: boolean;
}

// "Make this file look pre-CoDev." Four terminal states:
//   - backup present → swap it over the live file (the user's pre-CoDev
//     state is reinstated).
//   - no backup, live file is CoDev's → delete it. No backup means nothing
//     preceded it, so removing it *is* the pre-CoDev state.
//   - no backup, live file is the user's → leave it untouched. We can't know
//     what preceded CoDev here, so we don't destroy it.
//   - neither file exists → noop; already at pre-CoDev state.
//
// The authorship gate carries the whole safety argument, because the restore
// below *consumes* the backup (renameSync), making "no backup + live file"
// ambiguous. It can mean CoDev wrote the file from scratch — but equally that
// this is a second restore and the live file is the pristine original the first
// run just reinstated, or that the user hand-wrote a config for a tool CoDev
// never configured (both `remove` and the bare `restore` sweep visit every
// tool). Only the first case is ours to delete.
// `force` bypasses the authorship gate, so a backup-less live file is deleted
// whoever wrote it and `kept-live` never happens. It deliberately does NOT touch
// the backup branch: a `*.backup` still wins and is still restored, because that
// file is the user's pre-CoDev original and reinstating it is the whole point.
function restoreKind(kind: BackupKind, force = false): RestoreResult {
	const sourcePath = sourcePathOf(kind);
	const backupPath = `${sourcePath}.backup`;

	const log = (result: RestoreResult): RestoreResult => {
		logInfo(`restore ${kind}: ${result.status}`, {
			action: "restore.kind",
			extra: {
				kind,
				status: result.status,
				source_path: result.sourcePath,
				forced: result.forced === true,
			},
		});
		return result;
	};

	if (existsSync(backupPath)) {
		rmSync(sourcePath, { force: true });
		renameSync(backupPath, sourcePath);
		return log({ status: "restored", sourcePath, backupPath });
	}

	if (existsSync(sourcePath)) {
		// Evaluated even under force, so the result can tell "this was ours" apart
		// from "force took a file that wasn't" instead of misreporting the latter.
		const authored = isCodevAuthored(kind);
		if (authored || force) {
			rmSync(sourcePath, { force: true });
			return log({
				status: "deleted",
				sourcePath,
				backupPath,
				forced: !authored,
			});
		}
		return log({ status: "kept-live", sourcePath, backupPath });
	}

	return log({ status: "noop", sourcePath, backupPath });
}

// Claude tools own three files (settings.json, .claude.json,
// .credentials.json), so `restoreTool` returns an array. Single-file tools
// return a length-1 array. Callers iterate and aggregate per-tool status.
const CLAUDE_RESTORE_KINDS: BackupKind[] = [
	"claude-settings",
	"claude-json",
	"claude-credentials",
];

export function restoreTool(tool: Tool, force = false): RestoreResult[] {
	if (
		tool === "claude-code" ||
		tool === "vscode-claude-code" ||
		tool === "jetbrains-claude-code"
	) {
		// Not a bare `.map(restoreKind)`: map's second arg is the index, which
		// would land in `force` and silently force every kind after the first.
		return CLAUDE_RESTORE_KINDS.map((kind) => restoreKind(kind, force));
	}
	return [restoreKind(kindForTool(tool), force)];
}

export function configureCodex(creds: Credentials): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup("codex-config");
	const sourcePath = sourcePathOf("codex-config");
	mkdirSync(dirname(sourcePath), { recursive: true });

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL();
	const model = requireModel(creds);
	const provider = resolveProvider(creds);

	writeToml(sourcePath, {
		[CODEX_K.model]: model,
		[CODEX_K.modelProvider]: provider.id,
		// The gateway model isn't in Codex's catalog, so Codex would otherwise
		// assume a 272K fallback window — larger than the real 196608 ceiling.
		// Pin the true window and compact at ~85% of it, mirroring Claude Code.
		[CODEX_K.modelContextWindow]: GATEWAY_CONTEXT_WINDOW,
		[CODEX_K.autoCompactTokenLimit]: GATEWAY_COMPACT_TRIGGER,
		[CODEX_K.modelProviders]: {
			[provider.id]: {
				[CODEX_K.name]: provider.name,
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
		: AI_GATEWAY_OPENAI_URL();
	const defaultModel = requireModel(creds);
	const allModels =
		creds.models && creds.models.length > 0 ? creds.models : [defaultModel];

	const lines: string[] = [];
	lines.push(
		`${CONTINUE_K.name}: ${yamlScalar(continueConfigName(resolveProvider(creds).name))}`,
	);
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
	return configureOpenCodeKind("opencode-config", creds);
}

// The codev-code fork consumes the exact same config shape; only the directory
// and filename differ (see sourcePathOf).
export function configureCodevCode(creds: Credentials): ConfigureResult[] {
	return configureOpenCodeKind("codev-code-config", creds);
}

// Read the top-level `mcp` map from an existing OpenCode-family config, or
// undefined when the file is absent, unparseable, or has no object-valued
// `mcp`. Best-effort by design: this writer has always recovered from corrupt
// configs by replacing them, and preservation must never change that.
function readPreservedMcp(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = parseJsonc(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const mcp = (raw as Record<string, unknown>)[OPENCODE_K.mcp];
		if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return undefined;
		return mcp as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function configureOpenCodeKind(
	kind: "opencode-config" | "codev-code-config",
	creds: Credentials,
): ConfigureResult[] {
	const { path: backupPath, created } = ensureBackup(kind);
	const sourcePath = sourcePathOf(kind);
	mkdirSync(dirname(sourcePath), { recursive: true });

	// Carry the `mcp` map across the rewrite. This writer doesn't just run at
	// install time: every gateway-key auto-refresh (refresh.ts) and model
	// switch rewrites the whole file, and dropping `mcp` there would silently
	// unwire MCP servers — CodeGraph's entry, or servers the user added — that
	// were wired after configure last ran.
	const mcp = readPreservedMcp(sourcePath);

	const baseUrl = creds.baseUrl
		? normalizeOpenCodeBaseUrl(creds.baseUrl)
		: AI_GATEWAY_OPENAI_URL();
	const defaultModel = requireModel(creds);
	const provider = resolveProvider(creds);
	// Fall back to [defaultModel] when `models` is unset so callers that don't
	// know about the list (e.g. older fixtures, the fallback path with no
	// fetched list) still produce a valid one-entry map. The chosen model leads
	// the map: with no top-level pin (see below) a first launch with no saved
	// selection falls through to the provider's first model, so ordering is
	// what carries the choice.
	const allModels = [
		...new Set([
			defaultModel,
			...(creds.models && creds.models.length > 0 ? creds.models : []),
		]),
	];

	// A custom-provider model with no `limit` defaults to context 0, which both
	// mis-sizes the window and disables OpenCode's auto-compaction entirely.
	// Declare the gateway's real window so compaction works; `output` is required
	// whenever a `limit` object is present.
	//
	// Image input defaults to off for custom-provider models, which makes
	// OpenCode strip attached images before the request and the model reply
	// that it can't see them. Declare image support so attachments pass
	// through; for a text-only model the gateway/model then decides (reject or
	// ignore) instead of the client silently dropping the image.
	const modelsMap = Object.fromEntries(
		allModels.map((id) => [
			id,
			{
				[OPENCODE_K.name]: id,
				[OPENCODE_K.attachment]: true,
				[OPENCODE_K.modalities]: {
					[OPENCODE_K.input]: [OPENCODE_K.text, OPENCODE_K.image],
					[OPENCODE_K.output]: [OPENCODE_K.text],
				},
				[OPENCODE_K.limit]: {
					[OPENCODE_K.context]: GATEWAY_CONTEXT_WINDOW,
					[OPENCODE_K.output]: GATEWAY_MAX_OUTPUT_TOKENS,
				},
			},
		]),
	);

	writeJson(sourcePath, {
		[OPENCODE_K.schema]: OPENCODE_SCHEMA_URL,
		...(mcp !== undefined ? { [OPENCODE_K.mcp]: mcp } : {}),
		// No top-level `model`. The install-time model choice exists for Claude
		// Code and Codex, which can only run one model at a time; OpenCode and
		// CoDev Code switch freely in-CLI (docs/hub/installation). A pin there
		// outranks their saved selection on every launch — it beats the recent
		// models in their state dir — so each in-CLI switch reverted on restart
		// and only hand-editing the config undid it. The chosen model leads the
		// models map instead, which decides the first launch and yields to any
		// later selection. This is why `codevhub model` steers only Claude Code
		// and Codex.
		// OpenCode has no percentage trigger; it compacts at `context − reserved`.
		// Reserve the headroom that lands the trigger at ~85% of the window, to
		// match Claude Code and Codex.
		[OPENCODE_K.compaction]: {
			[OPENCODE_K.auto]: true,
			[OPENCODE_K.reserved]: GATEWAY_COMPACT_RESERVED,
		},
		[OPENCODE_K.provider]: {
			[provider.id]: {
				[OPENCODE_K.npm]: OPENCODE_K.npmPkg,
				[OPENCODE_K.name]: provider.name,
				[OPENCODE_K.options]: {
					[OPENCODE_K.baseURL]: baseUrl,
					[OPENCODE_K.apiKey]: creds.apiKey,
				},
				[OPENCODE_K.models]: modelsMap,
			},
		},
	});

	return [{ kind, sourcePath, backupPath, created }];
}
