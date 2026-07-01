import { loadSkillhubCookie, silentSso } from "@/lib/auth.js";
import { SKILLHUB_URL } from "@/lib/const.js";
import { loggedFetch } from "@/lib/log.js";

// SkillHub handshakes are quick JSON requests — cap them so a stalled registry
// surfaces as an error instead of hanging the CLI.
const SKILLHUB_TIMEOUT_MS = 15_000;
const SESSION_COOKIE_NAME = "skill-hub-session";

// Thrown when SkillHub can't authenticate the request at all (no local
// credential, or the SSO session/cookie is gone or expired). Carries an
// actionable "log in again" message. A 403 (authenticated but not permitted)
// is NOT this — it flows back to the caller as a normal Response to interpret.
export class SkillhubAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillhubAuthError";
	}
}

export interface SkillhubUser {
	id: string;
	username: string;
	role: string;
}

// Pick the credential for an authenticated SkillHub request. A stored admin
// cookie (local ADMIN/SUPERADMIN accounts from `codev login --admin`) wins;
// otherwise we ride the SSO session, auto-refreshing the access token via
// silentSso() so a background call never triggers an interactive login.
async function skillhubAuthHeaders(): Promise<Record<string, string>> {
	const cookie = loadSkillhubCookie();
	if (cookie) return { Cookie: cookie };

	const auth = await silentSso();
	if (!auth) {
		throw new SkillhubAuthError(
			"Not logged in to SkillHub. Run `codev login` (SSO) or `codev login --admin`.",
		);
	}
	return { Authorization: `Bearer ${auth.access_token}` };
}

export interface SkillhubFetchOptions extends RequestInit {
	// Short label for the diagnostic log's `endpoint` field. Defaults to the path.
	label?: string;
}

// Authenticated fetch against the SkillHub registry. Prepends SKILLHUB_URL,
// attaches the right credential (cookie or Bearer), and routes through
// loggedFetch. A 401 is normalized into a SkillhubAuthError with a re-login
// hint; every other status (including 403) is returned for the caller to read.
export async function skillhubFetch(
	path: string,
	opts: SkillhubFetchOptions = {},
): Promise<Response> {
	const { label, headers, signal, ...rest } = opts;
	const authHeaders = await skillhubAuthHeaders();
	const url = `${SKILLHUB_URL}${path.startsWith("/") ? path : `/${path}`}`;

	const res = await loggedFetch(label ?? "skillhub.request", url, {
		...rest,
		headers: {
			Accept: "application/json",
			...authHeaders,
			...(headers as Record<string, string> | undefined),
		},
		signal: signal ?? AbortSignal.timeout(SKILLHUB_TIMEOUT_MS),
	});

	if (res.status === 401) {
		throw new SkillhubAuthError(
			"SkillHub session expired or invalid (401). Run `codev login` again.",
		);
	}
	return res;
}

// Local ADMIN/SUPERADMIN sign-in: POST /api/auth/signin and capture the
// `skill-hub-session` cookie from the Set-Cookie header. Does NOT persist —
// `codev login --admin` saves the returned cookie via saveSkillhubCookie once
// the sign-in is confirmed. Regular users are rejected server-side (they must
// use SSO), surfaced here as the server's error message.
export async function skillhubSignIn(
	username: string,
	password: string,
): Promise<{ cookie: string; user: SkillhubUser }> {
	const res = await loggedFetch(
		"skillhub.signin",
		`${SKILLHUB_URL}/api/auth/signin`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ username, password }),
			signal: AbortSignal.timeout(SKILLHUB_TIMEOUT_MS),
		},
	);

	const body = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		data?: SkillhubUser;
		error?: string;
	};
	if (!res.ok || !body.success || !body.data) {
		throw new Error(body.error ?? `Sign-in failed (${res.status})`);
	}

	const cookie = extractSessionCookie(res.headers);
	if (!cookie) {
		throw new Error("Sign-in succeeded but no session cookie was returned.");
	}
	return { cookie, user: body.data };
}

// Pull the `skill-hub-session` cookie out of a Set-Cookie header, keeping only
// the `name=value` pair (dropping Path/HttpOnly/Expires/… attributes) so it's a
// valid Cookie request header. Node 22+ always exposes Headers.getSetCookie().
function extractSessionCookie(headers: Headers): string | null {
	for (const raw of headers.getSetCookie()) {
		if (raw.startsWith(`${SESSION_COOKIE_NAME}=`)) {
			return raw.split(";")[0]?.trim() ?? null;
		}
	}
	return null;
}
