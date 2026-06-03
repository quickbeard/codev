import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4=");
export const DEFAULT_PROXY_URL = `${BASE_URL}/codev-proxy`;
export const SSO_URL = `${BASE_URL}/sso-wrapper`;
export const AI_GATEWAY_URL = `${BASE_URL}/gateway`;
export const AI_GATEWAY_OPENAI_URL = `${AI_GATEWAY_URL}/v1`;
export const SKILLHUB_REGISTRY = `${BASE_URL}/netmindhub`;

// Self-hosted gateway model has a 196608-token window. Telling Claude Code
// to treat that as its effective window and to fire auto-compaction at 85%
// of it (≈167K) keeps compaction well below the hard limit.
export const CLAUDE_AUTO_COMPACT_WINDOW = "196608";
export const CLAUDE_AUTOCOMPACT_PCT = "85";

export const VERSION: string = pkg.version;

export const HELP_HINT = "Run `codev --help` to see all commands.";
export const HAPPY_CODING = "Happy coding! 🎉";

interface CodevAuthFile {
	supabase_url?: string;
	supabase_anon_key?: string;
	proxy_url?: string;
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
			`Missing ${label} in ~/.codev/auth.json. Run \`codev install\` (or log in again) to fetch the latest configuration.`,
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

// User-overridable: returns the proxy_url from ~/.codev/auth.json if set,
// otherwise the baked-in default. Picked during `codev install` / `codev
// config` via the ProxyUrl Step.
export function PROXY_URL(): string {
	const override = readCodevAuthFile()?.proxy_url;
	return override && override.length > 0 ? override : DEFAULT_PROXY_URL;
}
