import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

export const BASE_URL = atob("aHR0cHM6Ly9uZXRtaW5kLnZpZXR0ZWwudm4v");

export const VERSION: string = pkg.version;

export const HELP_HINT = "Run `codev --help` to see all commands.";
export const HAPPY_CODING = "Happy coding! 🎉";

// Supabase coordinates are no longer baked into the source. They are
// provisioned by codev-proxy's POST /config endpoint on every successful SSO
// login and persisted into ~/.codev/auth.json. The accessors below read the
// live values; missing values hard-fail with a "run codev install" message.
//
// Inline file read (rather than importing from auth.ts) avoids a circular
// import: auth.ts depends on BASE_URL above.

interface CodevAuthFile {
	supabase_url?: string;
	supabase_anon_key?: string;
	supabase_proxy_url?: string;
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

export function SUPABASE_PROXY_URL(): string {
	return readField("supabase_proxy_url", "supabase_proxy_url");
}
