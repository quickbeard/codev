import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPABASE_AUTH_PROVIDER = "custom:vtnet-oidc";

export interface SupabaseConfig {
	url: string;
	anonKey: string;
}

function env(name: string): string {
	return process.env[name]?.trim() ?? "";
}

function readAiHubEnv(): Partial<SupabaseConfig> {
	const candidates = [
		join(process.cwd(), ".env.local"),
		join(process.cwd(), "ai-hub-web", ".env.local"),
		"/Users/mac/Documents/zen8-solution/codev/ai-hub-web/.env.local",
	];
	for (const path of candidates) {
		try {
			const raw = readFileSync(path, "utf8");
			const values = Object.fromEntries(
				raw
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#") && line.includes("="))
					.map((line) => {
						const i = line.indexOf("=");
						return [
							line.slice(0, i),
							line.slice(i + 1).replace(/^["']|["']$/g, ""),
						];
					}),
			);
			return {
				url: values.NEXT_PUBLIC_SUPABASE_URL,
				anonKey: values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
			};
		} catch {
			// Try next candidate.
		}
	}
	return {};
}

export function getSupabaseConfig(): SupabaseConfig {
	const file = readAiHubEnv();
	const url =
		env("CODEV_SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL") || file.url;
	const anonKey =
		env("CODEV_SUPABASE_ANON_KEY") ||
		env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ||
		file.anonKey;
	if (!url || !anonKey) {
		throw new Error(
			"Supabase config missing. Set CODEV_SUPABASE_URL and CODEV_SUPABASE_ANON_KEY.",
		);
	}
	return { url: url.replace(/\/+$/, ""), anonKey };
}
