import { randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import open from "open";
import { loadSkillhubSession, saveSkillhubSession } from "@/lib/auth.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";

const SESSION_COOKIE_NAME = "skill-hub-session";
// Match the SSO login window so the two browser steps feel consistent.
const CAPTURE_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 10_000;

// Indirection layer so tests can spy on the browser launch without mocking
// node:child_process. Mirrors `browserOpener` in auth.ts; `open` handles the
// per-platform quirks (cmd.exe quoting, xdg-open, WSL detection).
export const browserOpener = {
	open(url: string): Promise<unknown> {
		return open(url);
	},
};

/**
 * Captures a SkillHub registry session and persists it into ~/.codev/auth.json.
 *
 * Best-effort by contract: this never throws. On any failure it logs a warning
 * (including the error message) via `onLog` and returns, so callers can chain
 * it after the SSO login without guarding — a registry hiccup must not fail the
 * gateway login that already succeeded.
 *
 * Flow: reuse a still-valid saved cookie if present; otherwise open a one-shot
 * loopback server, send the browser to the registry's `/cli/auth` consent page
 * (which POSTs the iron-session cookie back to the loopback), verify it against
 * `/api/v1/me`, and save it.
 */
export async function captureSkillhubSession(
	onLog: (msg: string) => void,
): Promise<void> {
	// Honor the SSO dev-bypass and a dedicated opt-out so neither pops a browser.
	if (process.env.CODEV_BYPASS_LOGIN === "1") return;
	if (process.env.CODEV_SKIP_SKILLHUB === "1") return;

	const registry = SKILLHUB_REGISTRY();

	// Returning users: if the saved cookie still validates for this registry,
	// skip the browser entirely.
	const existing = loadSkillhubSession();
	if (existing && existing.registry === registry) {
		try {
			const user = await verifyCookie(registry, existing.cookie);
			onLog(`SkillHub registry already connected as ${user.username}`);
			return;
		} catch {
			// Stale/expired cookie — fall through to a fresh capture.
		}
	}

	let handle: LoopbackHandle | null = null;
	try {
		handle = await startLoopbackAuth(CAPTURE_TIMEOUT_MS);
		const authorizeUrl =
			`${registry}/cli/auth?cb=${encodeURIComponent(handle.callbackUrl)}` +
			`&state=${encodeURIComponent(handle.state)}`;
		onLog("Connecting SkillHub registry...");
		onLog(`If the browser does not open, visit:\n${authorizeUrl}`);
		browserOpener.open(authorizeUrl).catch(() => {});

		const raw = await handle.wait();
		const cookie = normalizeSessionCookie(raw);
		if (!cookie) {
			throw new Error(`no '${SESSION_COOKIE_NAME}' value in the response`);
		}
		const user = await verifyCookie(registry, cookie);
		saveSkillhubSession({ registry, cookie, user });
		onLog(`✓ SkillHub registry connected as ${user.username}`);
	} catch (err) {
		handle?.cancel();
		const msg = err instanceof Error ? err.message : String(err);
		onLog(`⚠ SkillHub registry not connected: ${msg} (continuing)`);
	}
}

interface MeResponse {
	success: boolean;
	data?: { username: string; role: string };
}

async function verifyCookie(
	registry: string,
	cookie: string,
): Promise<{ username: string; role: string }> {
	const res = await fetch(`${registry}/api/v1/me`, {
		headers: { Accept: "application/json", Cookie: cookie },
		signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`/api/v1/me returned ${res.status}`);
	}
	const body = (await res.json()) as MeResponse;
	if (!body.success || !body.data) {
		throw new Error("/api/v1/me returned no profile");
	}
	return { username: body.data.username, role: body.data.role };
}

/**
 * Accepts a bare cookie value, a `name=value` pair, or a full Set-Cookie line,
 * and returns a normalized `skill-hub-session=<value>` Cookie fragment — or
 * null if no recognizable session cookie is present.
 */
export function normalizeSessionCookie(input: string): string | null {
	const trimmed = input.trim().replace(/^Cookie:\s*/i, "");
	if (!trimmed) return null;

	const firstPair = trimmed.split(";")[0]?.trim() ?? "";
	if (firstPair.includes("=")) {
		const [name, ...rest] = firstPair.split("=");
		const value = rest.join("=").trim();
		if (!value) return null;
		if (name?.trim() === SESSION_COOKIE_NAME) {
			return `${SESSION_COOKIE_NAME}=${value}`;
		}
		// A different cookie was pasted — search the whole input for ours.
		const m = trimmed.match(/skill-hub-session=([^;\s]+)/);
		if (m) return `${SESSION_COOKIE_NAME}=${m[1]}`;
		return null;
	}

	// Bare value — assume it's the cookie value.
	return `${SESSION_COOKIE_NAME}=${firstPair}`;
}

interface LoopbackHandle {
	/** http://127.0.0.1:<port>/cb — passed to the consent page as `cb`. */
	callbackUrl: string;
	/** Random state echoed back by the page; CSRF + reply matching. */
	state: string;
	/** Resolves with the captured raw cookie value. */
	wait(): Promise<string>;
	/** Tear the local server down without waiting. */
	cancel(): void;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>SkillHub — connected</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<h1 style="color:#22c55e">SkillHub registry connected</h1>
<p>You can close this tab and return to the terminal.</p>
</div>
</body>
</html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>SkillHub — error</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<h1 style="color:#ef4444">Could not connect SkillHub</h1>
<p>${msg}</p>
</div>
</body>
</html>`;

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > maxBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function parseFormBody(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of body.split("&")) {
		if (!pair) continue;
		const [k, ...rest] = pair.split("=");
		if (!k) continue;
		out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(
			rest.join("=").replace(/\+/g, " "),
		);
	}
	return out;
}

/**
 * Starts a one-shot HTTP server on 127.0.0.1:<random-port> and awaits a single
 * `POST /cb` (application/x-www-form-urlencoded) carrying `state` + `token`.
 * Rejects on state mismatch, missing token, timeout, or cancel().
 */
function startLoopbackAuth(timeoutMs: number): Promise<LoopbackHandle> {
	const state = randomBytes(24).toString("hex");

	let resolveToken!: (value: string) => void;
	let rejectToken!: (err: Error) => void;
	const tokenPromise = new Promise<string>((res, rej) => {
		resolveToken = res;
		rejectToken = rej;
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	let server: Server | undefined;
	let settled = false;
	const teardown = () => {
		if (timer) clearTimeout(timer);
		if (server) {
			try {
				server.close();
			} catch {
				// ignore
			}
			try {
				server.closeAllConnections?.();
			} catch {
				// ignore
			}
		}
	};

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const host = req.headers.host ?? "127.0.0.1";
			const url = new URL(req.url ?? "/", `http://${host}`);

			if (req.method === "OPTIONS") {
				res
					.writeHead(204, {
						"Access-Control-Allow-Origin": "*",
						"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
						"Access-Control-Allow-Headers": "content-type",
					})
					.end();
				return;
			}

			if (req.method !== "POST" || url.pathname !== "/cb") {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("not found");
				return;
			}

			const ctype = (req.headers["content-type"] ?? "").split(";")[0]?.trim();
			if (ctype !== "application/x-www-form-urlencoded") {
				res.writeHead(415, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("unsupported media type");
				return;
			}

			const form = parseFormBody(await readBody(req, 64 * 1024));
			const incomingState = form.state ?? "";
			const incomingToken = form.token ?? "";

			if (!incomingState || incomingState !== state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(ERROR_HTML("State mismatch — please restart `codev login`."));
				return;
			}
			if (!incomingToken) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(ERROR_HTML("Missing token — please restart `codev login`."));
				return;
			}

			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(SUCCESS_HTML);

			if (!settled) {
				settled = true;
				resolveToken(incomingToken);
				// Defer teardown so the response flushes first.
				setTimeout(teardown, 50).unref();
			}
		} catch (err) {
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("internal error");
			}
			if (!settled) {
				settled = true;
				rejectToken(err instanceof Error ? err : new Error(String(err)));
				setTimeout(teardown, 50).unref();
			}
		}
	};

	return new Promise<LoopbackHandle>((resolve, reject) => {
		server = createServer(handler);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server?.address() as AddressInfo;
			const callbackUrl = `http://127.0.0.1:${addr.port}/cb`;

			timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					rejectToken(
						new Error(
							`timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser`,
						),
					);
					teardown();
				}
			}, timeoutMs);
			timer.unref();

			resolve({
				callbackUrl,
				state,
				wait: () => tokenPromise,
				cancel: () => {
					if (!settled) {
						settled = true;
						rejectToken(new Error("cancelled"));
					}
					teardown();
				},
			});
		});
	});
}
