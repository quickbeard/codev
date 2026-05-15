import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4=");
const DEFAULT_PROXY_URL = `${BASE_URL}/codev-proxy`;
export const SSO_URL = `${BASE_URL}/sso-wrapper`;
export const AI_GATEWAY_URL = `${BASE_URL}/gateway`;
export const AI_GATEWAY_OPENAI_URL = `${AI_GATEWAY_URL}/v1`;

// Self-hosted deployments can override the proxy URL via the install flow
// (the ProxyUrl phase persists the choice to ~/.codev/auth.json). We read it
// inline rather than importing loadProxyUrl from auth.ts to avoid a circular
// dependency — proxy.ts imports const.ts, and auth.ts imports proxy.ts.
export function PROXY_URL(): string {
	const override = readCodevAuthFile()?.proxy_url;
	return override ?? DEFAULT_PROXY_URL;
}

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
