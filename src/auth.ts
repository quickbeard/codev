import {
	chmodSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import open from "open";
import { getSupabaseConfig, SUPABASE_AUTH_PROVIDER } from "@/supabase.js";

const SUPABASE_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function authFilePath() {
	return join(homedir(), ".codev", "auth.json");
}

function forceLoginPath() {
	return join(homedir(), ".codev", "force-login");
}

function markForceLogin() {
	try {
		const path = forceLoginPath();
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, "", { mode: 0o600 });
	} catch {
		// Best-effort; worst case is a silent SSO login on the next run.
	}
}

function clearForceLogin() {
	try {
		unlinkSync(forceLoginPath());
	} catch {
		// Fine if it didn't exist.
	}
}

export interface AuthData {
	access_token: string;
	id_token: string;
	refresh_token?: string;
	expires_at: number;
	user: {
		sub: string;
		email: string;
		displayName: string;
	};
}

interface TokenResponse {
	access_token: string;
	id_token?: string;
	refresh_token?: string;
	expires_in: number;
	expires_at?: number;
	user?: {
		id?: string;
		email?: string;
		user_metadata?: {
			full_name?: string;
			name?: string;
			displayName?: string;
		};
	};
}

function readAuthFile(): AuthData | null {
	try {
		return JSON.parse(readFileSync(authFilePath(), "utf-8")) as AuthData;
	} catch {
		return null;
	}
}

export function loadAuth(): AuthData | null {
	const data = readAuthFile();
	if (!data) return null;
	if (Date.now() + SUPABASE_TOKEN_EXPIRY_BUFFER_MS > data.expires_at)
		return null;
	return data;
}

function saveAuth(data: AuthData) {
	const path = authFilePath();
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdirSync's mode is ignored when the directory already exists, and
	// writeFileSync's mode is ignored when the file already exists, so
	// re-apply permissions explicitly to tighten any pre-existing loose perms.
	chmodSync(dir, 0o700);
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

export async function logout(): Promise<boolean> {
	try {
		unlinkSync(authFilePath());
	} catch {
		return false;
	}
	markForceLogin();
	return true;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Runs the full OAuth2 Authorization Code flow with PKCE:
 * 1. Reuse cached tokens if still valid
 * 2. Try a silent refresh if a refresh_token is on disk
 * 3. Otherwise: start a loopback HTTP server, send the user to /authorize
 *    with state + nonce + PKCE, wait for the callback, exchange code for
 *    tokens, fetch userinfo, and persist to ~/.codev/auth.json
 */
export async function login(
	onLog: (msg: string) => void,
	onReady: (openBrowserFn: () => void) => void,
): Promise<AuthData> {
	onLog("Starting Supabase SSO login...");
	const config = getSupabaseConfig();

	const existing = loadAuth();
	if (existing) {
		onLog(`Already logged in as ${existing.user.email}`);
		return existing;
	}

	const stale = readAuthFile();
	if (stale?.refresh_token) {
		try {
			onLog("Refreshing session...");
			const refreshed = await refreshTokens(config, stale.refresh_token);
			const authData = authDataFromToken(refreshed, stale.refresh_token);
			saveAuth(authData);
			onLog(`Logged in as ${authData.user.email}`);
			return authData;
		} catch {
			onLog("Refresh failed, starting full login...");
		}
	}

	const verifier = generateCodeVerifier();
	const challenge = await generateCodeChallenge(verifier);

	const { code } = await getAuthCode(onLog, onReady, challenge, config.url);

	const tokenRes = await exchangeCode(config, code, verifier);
	const authData = authDataFromToken(tokenRes);

	saveAuth(authData);
	clearForceLogin();
	onLog(`Logged in as ${authData.user.email}`);
	return authData;
}

async function getAuthCode(
	onLog: (msg: string) => void,
	onReady: (openBrowserFn: () => void) => void,
	codeChallenge: string,
	supabaseUrl: string,
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		const finish = () => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
		};

		// Captured once when listen() completes. The request handler must use
		// this rather than re-reading server.address(), which returns null after
		// server.close() — a stray browser request firing after /callback closed
		// the server (e.g. a keep-alive followup or favicon poke) would otherwise
		// throw "Cannot destructure property 'port' of 'server.address(...)'".
		let boundPort = 0;

		const buildAuthorizeUrl = (port: number) => {
			const redirectUri = `http://127.0.0.1:${port}/callback`;
			const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
			url.searchParams.set("provider", SUPABASE_AUTH_PROVIDER);
			url.searchParams.set("redirect_to", redirectUri);
			url.searchParams.set("scopes", "openid profile email");
			url.searchParams.set("code_challenge", codeChallenge);
			url.searchParams.set("code_challenge_method", "S256");
			return url.toString();
		};

		const server = createServer((req, res) => {
			const host = req.headers.host ?? "127.0.0.1";
			const url = new URL(req.url ?? "/", `http://${host}`);

			if (url.pathname !== "/callback") {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
				return;
			}

			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");

			const respond = (ok: boolean, msg?: string) => {
				res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" });
				res.end(loginResultHtml(ok, msg));
			};

			if (error) {
				const desc = url.searchParams.get("error_description") || error;
				respond(false, desc);
				finish();
				server.close();
				reject(new Error(`SSO login failed: ${desc}`));
				return;
			}

			if (!code) {
				respond(false, "No authorization code received");
				finish();
				server.close();
				reject(new Error("No authorization code received"));
				return;
			}

			respond(true);
			finish();
			server.close();
			resolve({
				code,
				redirectUri: `http://127.0.0.1:${boundPort}/callback`,
			});
		});

		server.listen(0, "127.0.0.1", () => {
			boundPort = (server.address() as AddressInfo).port;
			const initialUrl = buildAuthorizeUrl(boundPort);

			onReady(() => {
				onLog("Opening browser for Supabase SSO login...");
				openBrowser(initialUrl);
			});

			timeoutHandle = setTimeout(() => {
				timeoutHandle = null;
				server.close();
				reject(new Error("Login timed out after 120 seconds"));
			}, 120_000);
		});
	});
}

async function exchangeCode(
	config: { url: string; anonKey: string },
	code: string,
	codeVerifier: string,
): Promise<TokenResponse> {
	const res = await fetch(`${config.url}/auth/v1/token?grant_type=pkce`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			apikey: config.anonKey,
		},
		body: JSON.stringify({
			auth_code: code,
			code_verifier: codeVerifier,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${body}`);
	}

	return (await res.json()) as TokenResponse;
}

async function refreshTokens(
	config: { url: string; anonKey: string },
	refreshToken: string,
): Promise<TokenResponse> {
	const res = await fetch(
		`${config.url}/auth/v1/token?grant_type=refresh_token`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				apikey: config.anonKey,
			},
			body: JSON.stringify({
				refresh_token: refreshToken,
			}),
		},
	);

	if (!res.ok) {
		throw new Error(`Token refresh failed (${res.status})`);
	}

	return (await res.json()) as TokenResponse;
}

function authDataFromToken(
	token: TokenResponse,
	fallbackRefresh?: string,
): AuthData {
	const user = token.user;
	const sub = user?.id ?? "";
	const email = user?.email ?? sub;
	const meta = user?.user_metadata ?? {};
	return {
		access_token: token.access_token,
		id_token: token.id_token ?? token.access_token,
		refresh_token: token.refresh_token || fallbackRefresh,
		expires_at: token.expires_at
			? token.expires_at * 1000
			: Date.now() + token.expires_in * 1000,
		user: {
			sub,
			email,
			displayName:
				meta.displayName || meta.full_name || meta.name || email || sub,
		},
	};
}

// Indirection layer so tests can spy on the browser launch without mocking
// node:child_process. The `open` npm package handles every platform quirk
// (cmd.exe quoting on Windows, xdg-open on Linux, WSL detection) that we
// previously tried to get right by hand.
export const browserOpener = {
	open(url: string): Promise<unknown> {
		return open(url);
	},
};

function openBrowser(url: string) {
	// Fire-and-forget: the loopback callback server resolves the login flow
	// regardless of whether the browser actually launched, and the URL is
	// already printed so the user can paste it as a fallback.
	browserOpener.open(url).catch(() => {});
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function loginResultHtml(success: boolean, error?: string): string {
	const title = success ? "Login Successful" : "Login Failed";
	const safeError = error ? escapeHtml(error) : "Unknown error";
	const message = success
		? "You have been logged in. You can close this tab and return to the terminal."
		: `Login failed: ${safeError}. Please try again.`;
	const color = success ? "#22c55e" : "#ef4444";

	return `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<h1 style="color:${color}">${title}</h1>
<p>${message}</p>
</div>
</body>
</html>`;
}
