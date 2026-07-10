import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4=");
export const BACKEND_URL = `${BASE_URL}/codev-backend`;
export const SSO_URL = `${BASE_URL}/sso-wrapper`;
export const LOGIN_SUCCESS_URL = `${BASE_URL}/codev-landing-page/oauth/success`;
export const SKILLHUB_URL = `${BASE_URL}/netmindhub`;

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
			readFileSync(join(homedir(), ".codev", "auth.json"), "utf-8"),
		) as CodevAuthFile;
	} catch {
		return null;
	}
}

function readField(field: keyof CodevAuthFile, label: string): string {
	const value = readCodevAuthFile()?.[field];
	if (!value) {
		throw new Error(
			`Missing ${label} in ~/.codev/auth.json. Run \`codevhub install\` (or log in again) to fetch the latest configuration.`,
		);
	}
	return value;
}

export function SUPABASE_URL(): string {
	return readField("supabase_url", "supabase_url");
}

export function SUPABASE_ANON_KEY(): string {
	return readField("supabase_anon_key", "supabase_anon_key");
}

export function AI_GATEWAY_URL(): string {
	return readField("gateway_url", "gateway_url");
}

export function AI_GATEWAY_OPENAI_URL(): string {
	return `${AI_GATEWAY_URL()}/v1`;
}
