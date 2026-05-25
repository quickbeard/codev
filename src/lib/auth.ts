import {
	chmodSync,
	existsSync,
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
import { SSO_URL } from "@/lib/const.js";
import { fetchCodevConfig } from "@/lib/proxy.js";

const CLIENT_ID = atob("bGl0ZWxsbS10ZXN0");
const REVOKE_TIMEOUT_MS = 3_000;

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

export interface ApiKeyCreds {
	apiKey: string;
	baseUrl?: string;
	model?: string;
}

// auth.json holds three independent blocks: SSO tokens (issued by the IdP),
// the gateway API key (issued by /auth/exchange or entered manually), and the
// CoDev runtime config (Supabase coordinates, fetched from codev-proxy's
// /config endpoint on every successful SSO login). They share a file because
// they're written together on a fresh install, but each is updated in
// isolation — saving SSO must not clobber the api_key or codev-config blocks,
// and `codev logout` strips SSO while preserving the rest for reuse.
interface AuthFileContents {
	access_token?: string;
	id_token?: string;
	refresh_token?: string;
	expires_at?: number;
	user?: AuthData["user"];
	api_key?: string;
	base_url?: string;
	model?: string;
	supabase_url?: string;
	supabase_anon_key?: string;
}

export interface CodevConfig {
	supabaseUrl: string;
	supabaseAnonKey: string;
}

interface TokenResponse {
	access_token: string;
	id_token: string;
	refresh_token?: string;
	expires_in: number;
}

function readAuthFile(): AuthFileContents | null {
	try {
		return JSON.parse(
			readFileSync(authFilePath(), "utf-8"),
		) as AuthFileContents;
	} catch {
		return null;
	}
}

function writeAuthFile(data: AuthFileContents): void {
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

export function loadAuth(): AuthData | null {
	const raw = readAuthFile();
	if (!raw) return null;
	if (!raw.access_token || !raw.id_token || !raw.expires_at || !raw.user) {
		return null;
	}
	if (Date.now() > raw.expires_at) return null;
	return {
		access_token: raw.access_token,
		id_token: raw.id_token,
		refresh_token: raw.refresh_token,
		expires_at: raw.expires_at,
		user: raw.user,
	};
}

function saveAuth(data: AuthData): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({
		...existing,
		access_token: data.access_token,
		id_token: data.id_token,
		refresh_token: data.refresh_token,
		expires_at: data.expires_at,
		user: data.user,
	});
}

export function saveApiKey(creds: ApiKeyCreds): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({
		...existing,
		api_key: creds.apiKey,
		base_url: creds.baseUrl,
		model: creds.model,
	});
}

export function saveCodevConfig(config: CodevConfig): void {
	const existing = readAuthFile() ?? {};
	writeAuthFile({
		...existing,
		supabase_url: config.supabaseUrl,
		supabase_anon_key: config.supabaseAnonKey,
	});
}

export function loadApiKey(): ApiKeyCreds | null {
	const raw = readAuthFile();
	if (!raw?.api_key) return null;
	return {
		apiKey: raw.api_key,
		baseUrl: raw.base_url,
		model: raw.model,
	};
}

export async function logout(): Promise<boolean> {
	const raw = readAuthFile();
	if (!raw) return false;
	const hasSso = !!(raw.access_token || raw.refresh_token);
	if (!hasSso) return false;
	try {
		const preserved: AuthFileContents = {
			api_key: raw.api_key,
			base_url: raw.base_url,
			model: raw.model,
			supabase_url: raw.supabase_url,
			supabase_anon_key: raw.supabase_anon_key,
		};
		const hasAnything = Object.values(preserved).some((v) => v !== undefined);
		if (hasAnything) {
			writeAuthFile(preserved);
		} else {
			unlinkSync(authFilePath());
		}
	} catch {
		return false;
	}
	// Revoking tokens does not terminate the IdP's browser session cookie, so
	// the next /authorize would otherwise silently return a new code. Mark the
	// next login to force re-authentication via prompt=login.
	markForceLogin();
	await revokeTokens(raw);
	return true;
}

async function revokeTokens(data: AuthFileContents): Promise<void> {
	const endpoint = `${SSO_URL}/revoke`;
	await Promise.all([
		data.access_token
			? revokeToken(endpoint, data.access_token, "access_token")
			: Promise.resolve(),
		data.refresh_token
			? revokeToken(endpoint, data.refresh_token, "refresh_token")
			: Promise.resolve(),
	]);
}

async function revokeToken(
	endpoint: string,
	token: string,
	tokenTypeHint: "access_token" | "refresh_token",
): Promise<void> {
	try {
		await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				token,
				token_type_hint: tokenTypeHint,
				client_id: CLIENT_ID,
			}),
			signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
		});
	} catch {
		// Best-effort; token will expire naturally if revocation fails.
	}
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
	onLog("Starting SSO login...");

	// Dev escape hatch: when CODEV_BYPASS_LOGIN=1 is set, skip the OAuth flow
	// entirely and persist a stub session. Useful when the SSO wrapper is down
	// and you still need to walk through `codev install` to test downstream
	// steps (npm install, configure, model select, etc.). The stub is real
	// auth.json on disk, so subsequent `codev claude/codex/opencode` runs and
	// the upload daemon also see a "logged in" state — clear it with
	// `codev logout` or by unsetting the env var + `codev remove`.
	if (process.env.CODEV_BYPASS_LOGIN === "1") {
		onLog("CODEV_BYPASS_LOGIN=1 — skipping SSO, using stub session.");
		const authData: AuthData = {
			access_token: "codev-bypass-no-sso",
			id_token: "codev-bypass-no-sso",
			expires_at: Date.now() + 3_600_000,
			user: {
				sub: "codev-bypass",
				email: "bypass@local",
				displayName: "Bypass User",
			},
		};
		saveAuth(authData);
		clearForceLogin();
		onLog(`Logged in as ${authData.user.email}`);
		return authData;
	}

	const existing = loadAuth();
	if (existing) {
		onLog(`Already logged in as ${existing.user.email}`);
		return existing;
	}

	const stale = readAuthFile();
	if (stale?.refresh_token) {
		try {
			onLog("Refreshing session...");
			const refreshed = await refreshTokens(stale.refresh_token);
			const user = await fetchUserInfo(refreshed.access_token);
			const authData: AuthData = {
				access_token: refreshed.access_token,
				id_token: refreshed.id_token,
				refresh_token: refreshed.refresh_token || stale.refresh_token,
				expires_at: Date.now() + refreshed.expires_in * 1000,
				user: {
					sub: user.sub,
					email: user.email,
					displayName: user.displayName || user.name || user.sub,
				},
			};
			saveAuth(authData);
			onLog(`Logged in as ${authData.user.email}`);
			return authData;
		} catch {
			onLog("Refresh failed, starting full login...");
		}
	}

	// Force re-auth via the IdP login form (prompt=login) when:
	//   1. ~/.codev/ doesn't exist — typically the user just ran `codev remove`
	//      (which wipes the dir), or this is a truly fresh install. We have no
	//      record of prior consent on this machine, so don't silently ride any
	//      IdP browser-session cookie that might still be valid from another
	//      app on the same SSO realm.
	//   2. The force-login sentinel is set — `codev logout` writes it because
	//      revoking tokens does not terminate the IdP's session cookie.
	const forceLogin =
		!existsSync(join(homedir(), ".codev")) || existsSync(forceLoginPath());

	const verifier = generateCodeVerifier();
	const challenge = await generateCodeChallenge(verifier);
	const state = crypto.randomUUID();
	const nonce = crypto.randomUUID();

	const { code, redirectUri } = await getAuthCode(
		onLog,
		onReady,
		state,
		challenge,
		nonce,
		forceLogin,
	);

	const tokenRes = await exchangeCode(code, redirectUri, verifier);
	const user = await fetchUserInfo(tokenRes.access_token);

	const authData: AuthData = {
		access_token: tokenRes.access_token,
		id_token: tokenRes.id_token,
		refresh_token: tokenRes.refresh_token,
		expires_at: Date.now() + tokenRes.expires_in * 1000,
		user: {
			sub: user.sub,
			email: user.email,
			displayName: user.displayName || user.name || user.sub,
		},
	};

	saveAuth(authData);
	clearForceLogin();
	onLog(`Logged in as ${authData.user.email}`);
	return authData;
}

// Best-effort: pull the latest Supabase coordinates from codev-proxy and
// persist them next to the SSO session. Failure is logged but not thrown —
// downstream accessors (SUPABASE_URL/ANON_KEY in const.ts) will hard-fail
// later if no values were ever fetched, with a "run codev install" message
// that's actionable for the user.
//
// Callers are responsible for invoking this after a successful login:
//   - InstallApp awaits it inline after the npm install completes (no visible
//     Step — the call blocks the transition to `validating-existing`/
//     `key-choice` but doesn't render a spinner of its own).
//   - upload.ts's ensureAuth runs it on the fresh-login branch, and again
//     in the retry path after a 401/403 from Supabase (config may have
//     rotated since the last login).
export async function refreshCodevConfig(
	accessToken: string,
	onLog: (msg: string) => void,
): Promise<void> {
	try {
		const config = await fetchCodevConfig(accessToken);
		saveCodevConfig(config);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		onLog(`Warning: could not refresh CoDev config: ${message}`);
	}
}

async function getAuthCode(
	onLog: (msg: string) => void,
	onReady: (openBrowserFn: () => void) => void,
	expectedState: string,
	codeChallenge: string,
	nonce: string,
	forceLogin: boolean,
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

		const buildAuthorizeUrl = (port: number) =>
			`${SSO_URL}/authorize?` +
			`response_type=code` +
			`&client_id=${encodeURIComponent(CLIENT_ID)}` +
			`&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}` +
			`&scope=openid%20profile%20email%20offline_access` +
			`&state=${expectedState}` +
			`&nonce=${nonce}` +
			`&code_challenge=${codeChallenge}` +
			`&code_challenge_method=S256`;

		const server = createServer((req, res) => {
			const host = req.headers.host ?? "127.0.0.1";
			const url = new URL(req.url ?? "/", `http://${host}`);

			// Step 1 (forceLogin only): CAS has just killed its session cookie
			// and redirected the browser back to us. Now bounce it to /authorize
			// so the wrapper can start a fresh login — this time CAS will show
			// the credential form because there's no session cookie.
			if (url.pathname === "/logout-done") {
				res.writeHead(302, { Location: buildAuthorizeUrl(boundPort) });
				res.end();
				return;
			}

			if (url.pathname !== "/callback") {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
				return;
			}

			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			const returnedState = url.searchParams.get("state");

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

			if (returnedState !== expectedState) {
				respond(false, "State mismatch");
				finish();
				server.close();
				reject(new Error("State mismatch (possible CSRF attack)"));
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
			const initialUrl = forceLogin
				? `${SSO_URL}/logout?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${boundPort}/logout-done`)}`
				: buildAuthorizeUrl(boundPort);

			onReady(() => {
				onLog(
					forceLogin
						? "Opening browser to end existing SSO session and re-login..."
						: "Opening browser for SSO login...",
				);
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
	code: string,
	redirectUri: string,
	codeVerifier: string,
): Promise<TokenResponse> {
	const res = await fetch(`${SSO_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: CLIENT_ID,
			code_verifier: codeVerifier,
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Token exchange failed (${res.status}): ${body}`);
	}

	return (await res.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
	const res = await fetch(`${SSO_URL}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
	});

	if (!res.ok) {
		throw new Error(`Token refresh failed (${res.status})`);
	}

	return (await res.json()) as TokenResponse;
}

async function fetchUserInfo(accessToken: string) {
	const res = await fetch(`${SSO_URL}/userinfo`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Failed to fetch user info (${res.status}): ${body}`);
	}

	return (await res.json()) as {
		sub: string;
		email: string;
		displayName?: string;
		name?: string;
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
