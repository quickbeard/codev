import { BASE_URL } from "@/const.js";

interface ExchangeResponse {
	api_key: string;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

interface ErrorResponse {
	error?: string;
}

function resolveUrl(envVar: string, fallback: string): string {
	return (process.env[envVar]?.trim() || fallback).replace(/\/+$/, "");
}

const PROXY_URL = resolveUrl("CODEV_PROXY_URL", `${BASE_URL}codev-proxy`);
const SUPABASE_PROXY_URL = resolveUrl(
	"CODEV_SUPABASE_PROXY_URL",
	`${BASE_URL}api/codev`,
);

export interface SupabaseSession {
	access_token: string;
	refresh_token?: string;
	expires_at?: number;
	expires_in?: number;
	user: {
		id: string;
		email: string;
	};
}

export async function fetchApiKey(accessToken: string): Promise<string> {
	const res = await fetch(`${PROXY_URL}/auth/exchange`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Proxy /auth/exchange failed (${res.status}): ${reason}`);
	}

	const data = (await res.json()) as ExchangeResponse;
	// Empty key is not thrown — callers route to manual-credentials fallback.
	return data.api_key ?? "";
}

export async function fetchSupabaseSession(
	accessToken: string,
): Promise<SupabaseSession> {
	const res = await fetch(`${SUPABASE_PROXY_URL}/supabase/exchange`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(
			`Proxy /supabase/exchange failed (${res.status}): ${reason}`,
		);
	}

	return (await res.json()) as SupabaseSession;
}
