import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4=");
export const BACKEND_URL = `${BASE_URL}/codev-backend`;
export const SSO_URL = `${BASE_URL}/sso-wrapper`;
export const LOGIN_SUCCESS_URL = `${BASE_URL}/codev/oauth/success`;
export const SKILLHUB_URL = `${BASE_URL}/netmindhub`;
// The landing page serves CoDev Code's static downloads (the vsix, ripgrep
// binaries) from its public/ dir under the site's /codev base path.
export const CODE_DOWNLOADS_URL = `${BASE_URL}/codev/docs/code/downloads`;

export const FALLBACK_MODEL = atob("TWluaU1heC9NaW5pTWF4LU0yLjc=");

// The self-hosted gateway model has a 196608-token window. Each agent is told
// to treat that as its effective window and to fire auto-compaction at ~85% of
// it (≈167K), keeping compaction well below the hard limit.
export const GATEWAY_CONTEXT_WINDOW = 196608;
export const GATEWAY_COMPACT_PCT = 85;
// Compaction trigger and reserve, derived from the window and percentage above.
// Codex's `model_auto_compact_token_limit` is an absolute token threshold (≈167K);
// OpenCode has no percentage knob — it compacts at `context − reserved`, so the
// reserve is the headroom that lands the trigger at the same ~85% point.
export const GATEWAY_COMPACT_TRIGGER = Math.round(
	GATEWAY_CONTEXT_WINDOW * (GATEWAY_COMPACT_PCT / 100),
);
export const GATEWAY_COMPACT_RESERVED =
	GATEWAY_CONTEXT_WINDOW - GATEWAY_COMPACT_TRIGGER;
// Max output tokens advertised to OpenCode (required whenever `limit` is set).
export const GATEWAY_MAX_OUTPUT_TOKENS = 65536;

export const VERSION: string = pkg.version;

// Node 22.21.0 (2025-10-20) is where HTTP_PROXY/HTTPS_PROXY support was
// backported to the 22 LTS line (nodejs/node#57872). Below it Node's `fetch`
// silently ignores proxy environment variables, so sign-in can never work
// behind a corporate proxy no matter how the user configures their shell —
// which is why the floor is this oddly specific patch and not a rounder number.
// It supersedes the older 22.5 floor, which only existed for `node:sqlite`.
//
// Lives here rather than in lib/doctor.ts so index.tsx can gate on it without
// pulling in doctor's dependency graph before the version check has run.
export const MIN_NODE = { major: 22, minor: 21, patch: 0 } as const;
export const MIN_NODE_STRING = "22.21.0";
export const RECOMMENDED_NODE = "24 (LTS)";
export const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

export function parseNodeVersion(version: string): [number, number, number] {
	const [major = 0, minor = 0, patch = 0] = version
		.replace(/^v/, "")
		.split(".")
		.map((n) => Number.parseInt(n, 10) || 0);
	return [major, minor, patch];
}

export function nodeVersionMeets(version: string): boolean {
	const [major, minor, patch] = parseNodeVersion(version);
	if (major !== MIN_NODE.major) return major > MIN_NODE.major;
	if (minor !== MIN_NODE.minor) return minor > MIN_NODE.minor;
	return patch >= MIN_NODE.patch;
}

export const HELP_HINT = "Run `codevhub --help` to see all commands.";
export const HAPPY_CODING = "Happy coding! 🎉";

interface CodevAuthFile {
	supabase_url?: string;
	supabase_anon_key?: string;
	gateway_url?: string;
}

function readCodevAuthFile(): CodevAuthFile | null {
	try {
		return JSON.parse(
			readFileSync(join(homedir(), ".codev-hub", "auth.json"), "utf-8"),
		) as CodevAuthFile;
	} catch {
		return null;
	}
}

function readField(field: keyof CodevAuthFile, label: string): string {
	const value = readCodevAuthFile()?.[field];
	if (!value) {
		throw new Error(
			`Missing ${label} in ~/.codev-hub/auth.json. Run \`codevhub install\` (or log in again) to fetch the latest configuration.`,
		);
	}
	return value;
}

// The analysis backend's coordinates. The on-disk keys keep their historical
// `supabase_*` names — they're the shape the CoDev backend hands back from
// /config and what every already-installed machine has cached.
export function ANALYSIS_BACKEND_URL(): string {
	return readField("supabase_url", "supabase_url");
}

export function ANALYSIS_BACKEND_ANON_KEY(): string {
	return readField("supabase_anon_key", "supabase_anon_key");
}

export function AI_GATEWAY_URL(): string {
	return readField("gateway_url", "gateway_url");
}

export function AI_GATEWAY_OPENAI_URL(): string {
	return `${AI_GATEWAY_URL()}/v1`;
}
