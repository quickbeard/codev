import type { CodevConfig } from "@/lib/auth.js";
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	PROXY_URL,
} from "@/lib/const.js";

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
}

interface ErrorResponse {
	error?: string;
}

const VALIDATE_TIMEOUT_MS = 5_000;
const MODELS_TIMEOUT_MS = 10_000;

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
	if (!data.supabaseUrl || !data.supabaseAnonKey) {
		throw new Error(
			`Proxy /config returned incomplete payload: ${JSON.stringify(data)}`,
		);
	}
	return {
		supabaseUrl: data.supabaseUrl,
		supabaseAnonKey: data.supabaseAnonKey,
	};
}

// Manual creds may include a `/v1` suffix (OpenAI-style); /key/info lives at
// the gateway root, so strip a trailing v1 segment before joining. Falls
// back to AI_GATEWAY_URL when the saved key has no base_url (SSO-fetched
// keys don't store one).
function keyInfoUrl(baseUrl?: string): string {
	const base = baseUrl ?? AI_GATEWAY_URL;
	const stripped = base.replace(/\/?v1\/?$/, "");
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

// Detects whether a thrown error from fetchModels was caused by an invalid
// key (401/403) — as opposed to a network/5xx/timeout. Used by `codev model`
// to decide whether to trigger the re-auth flow.
export function isInvalidKeyError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /Models fetch failed \((?:401|403)\)/.test(msg);
}

// Hits the OpenAI-compatible /v1/models endpoint. AI_GATEWAY_OPENAI_URL
// already ends in /v1; manual baseUrls may or may not — normalize either way
// so we always end up at `<base>/v1/models`.
function modelsUrl(baseUrl?: string): string {
	const base = baseUrl ?? AI_GATEWAY_OPENAI_URL;
	const withV1 = /\/v1\/?$/.test(base)
		? base.replace(/\/$/, "")
		: `${base.replace(/\/$/, "")}/v1`;
	return `${withV1}/models`;
}

// Fetches the list of model IDs available to the given API key. Throws on
// non-2xx, network errors, timeout, or an empty result — callers fail-stop
// (there is no silent fallback to a hardcoded default).
export async function fetchModels(
	apiKey: string,
	baseUrl?: string,
): Promise<string[]> {
	const res = await fetch(modelsUrl(baseUrl), {
		method: "GET",
		headers: {
			accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as ErrorResponse;
		const reason = body.error || res.statusText;
		throw new Error(`Models fetch failed (${res.status}): ${reason}`);
	}
	const data = (await res.json()) as { data?: Array<{ id?: string }> };
	const ids = (data.data ?? [])
		.map((m) => m.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (ids.length === 0) throw new Error("Gateway returned no models");
	return ids;
}

export async function fetchSupabaseSession(
	accessToken: string,
): Promise<SupabaseSession> {
	const res = await fetch(`${PROXY_URL}/supabase/exchange`, {
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
