import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/const.js";

export interface SupabaseConfig {
	url: string;
	anonKey: string;
}

function env(name: string): string {
	return process.env[name]?.trim() ?? "";
}

export function getSupabaseConfig(): SupabaseConfig {
	const url =
		env("CODEV_SUPABASE_URL") ||
		env("NEXT_PUBLIC_SUPABASE_URL") ||
		SUPABASE_URL;
	const anonKey =
		env("CODEV_SUPABASE_ANON_KEY") ||
		env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") ||
		SUPABASE_ANON_KEY;
	return { url: url.replace(/\/+$/, ""), anonKey };
}
