import type { CodevConfig } from "@/lib/auth.js";
import { BASE_URL, SUPABASE_PROXY_URL } from "@/lib/const.js";

interface ExchangeResponse {
	api_key: string;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

interface ConfigResponse {
	supabaseUrl: string;
	supabaseAnonKey: string;
	supabaseProxyUrl: string;
}

interface ErrorResponse {
	error?: string;
}

const PROXY_URL = `${BASE_URL}codev-proxy`;
const GATEWAY_BASE_URL = `${BASE_URL}gateway/`;
const VALIDATE_TIMEOUT_MS = 5_000;

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

// Pulls the Supabase coordinates the CLI doesn't bake into its source. Called
// from auth.ts on every successful SSO login (fresh + refresh) and persisted
// into ~/.codev/auth.json by saveCodevConfig.
export async function fetchCodevConfig(
	accessToken: string,
): Promise<CodevConfig> {
	const res = await fetch(`${PROXY_URL}/config`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Proxy /config failed (${res.status}): ${reason}`);
	}

	const data = (await res.json()) as ConfigResponse;
	if (!data.supabaseUrl || !data.supabaseAnonKey || !data.supabaseProxyUrl) {
		throw new Error(
			`Proxy /config returned incomplete payload: ${JSON.stringify(data)}`,
		);
	}
	return {
		supabaseUrl: data.supabaseUrl,
		supabaseAnonKey: data.supabaseAnonKey,
		supabaseProxyUrl: data.supabaseProxyUrl,
	};
}

// Manual creds may include a `/v1` suffix (OpenAI-style); /key/info lives at
// the gateway root, so strip a trailing v1 segment before joining.
function keyInfoUrl(baseUrl?: string): string {
	if (!baseUrl) return `${GATEWAY_BASE_URL}key/info`;
	const stripped = baseUrl.replace(/\/?v1\/?$/, "");
	const trailing = stripped.endsWith("/") ? stripped : `${stripped}/`;
	return `${trailing}key/info`;
}

// Validates a key against the gateway's /key/info endpoint (LiteLLM): a single
// hash-based lookup against the key table. Returns true on 2xx, false on
// 401/403 (invalid/revoked), throws on network errors so the caller can
// distinguish "key is bad" from "couldn't reach the gateway".
export async function validateApiKey(
	apiKey: string,
	baseUrl?: string,
): Promise<boolean> {
	const res = await fetch(keyInfoUrl(baseUrl), {
		method: "GET",
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return false;
	if (!res.ok) {
		throw new Error(`Validation failed (${res.status}): ${res.statusText}`);
	}
	return true;
}

export async function fetchSupabaseSession(
	accessToken: string,
): Promise<SupabaseSession> {
	const supabaseProxyUrl = SUPABASE_PROXY_URL().replace(/\/+$/, "");
	const res = await fetch(`${supabaseProxyUrl}/supabase/exchange`, {
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
