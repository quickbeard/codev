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

const PROXY_URL = `${BASE_URL}codev-proxy`;
const GATEWAY_BASE_URL = `${BASE_URL}gateway/`;
const VALIDATE_TIMEOUT_MS = 5_000;

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
