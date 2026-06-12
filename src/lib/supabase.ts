import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/const.js";

export interface SupabaseConfig {
	url: string;
	anonKey: string;
}

// Reads the Supabase coordinates that the backend provisioned at the last
// successful SSO login. Both accessors hard-fail with a "run codev install"
// message if the values aren't on disk, so callers don't need their own
// missing-config branch.
export function getSupabaseConfig(): SupabaseConfig {
	return {
		url: SUPABASE_URL().replace(/\/+$/, ""),
		anonKey: SUPABASE_ANON_KEY(),
	};
}
