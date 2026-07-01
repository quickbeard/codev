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

// Pick the credential for a SkillHub request. A stored admin cookie (local
// ADMIN/SUPERADMIN accounts from `codev login --admin`) wins; otherwise we ride
// the SSO session, auto-refreshing the access token via silentSso() so a
// background call never triggers an interactive login. When `optional` is set
// (public endpoints like the hub listing), missing credentials yield no auth
// header rather than an error.
async function skillhubAuthHeaders(
	optional: boolean,
): Promise<Record<string, string>> {
	const cookie = loadSkillhubCookie();
	if (cookie) return { Cookie: cookie };

	const auth = await silentSso();
	if (auth) return { Authorization: `Bearer ${auth.access_token}` };

	if (optional) return {};
	throw new SkillhubAuthError(
		"Not logged in to SkillHub. Run `codev login` (SSO) or `codev login --admin`.",
	);
}

export interface SkillhubFetchOptions extends RequestInit {
	// Short label for the diagnostic log's `endpoint` field. Defaults to the path.
	label?: string;
	// Public endpoint: attach a credential if one is available, but don't require
	// login. Default false — most endpoints need auth.
	optionalAuth?: boolean;
}

// Authenticated fetch against the SkillHub registry. Prepends SKILLHUB_URL,
// attaches the right credential (cookie or Bearer), and routes through
// loggedFetch. A 401 is normalized into a SkillhubAuthError with a re-login
// hint; every other status (including 403) is returned for the caller to read.
export async function skillhubFetch(
	path: string,
	opts: SkillhubFetchOptions = {},
): Promise<Response> {
	const { label, headers, signal, optionalAuth, ...rest } = opts;
	const authHeaders = await skillhubAuthHeaders(optionalAuth ?? false);
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

// A public skill as returned by GET /api/v1/hub/skills. The endpoint carries
// more fields (metadata, author, counts, zipUrl); we type only what search
// renders and ignore the rest.
export interface HubSkill {
	id: string;
	name: string;
	provider: string;
	description: string;
	version: string;
	publishedAt: string | null;
}

export interface HubSearchResult {
	// Total matches server-side (may exceed items.length when capped by limit).
	total: number;
	items: HubSkill[];
}

// Browse/search the public hub. Authentication is optional — the listing is
// public — so a logged-out user can search; a stored session is attached when
// present (e.g. so private-namespace context could apply server-side later).
export async function listHubSkills(
	opts: { search?: string; limit?: number } = {},
): Promise<HubSearchResult> {
	const params = new URLSearchParams();
	if (opts.search) params.set("search", opts.search);
	if (opts.limit) params.set("limit", String(opts.limit));
	const qs = params.toString();

	const res = await skillhubFetch(`/api/v1/hub/skills${qs ? `?${qs}` : ""}`, {
		label: "skillhub.hub-skills",
		optionalAuth: true,
	});
	if (!res.ok) {
		throw new Error(`Skill search failed (${res.status}).`);
	}

	const body = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		data?: HubSkill[];
		pagination?: { total?: number };
	};
	if (!body.success || !body.data) {
		throw new Error("SkillHub returned an unexpected response.");
	}
	return {
		total: body.pagination?.total ?? body.data.length,
		items: body.data,
	};
}

export interface SkillMeta {
	id: string;
	name: string;
	version?: string;
}

// Resolve a skill's canonical metadata by id OR name — the server's
// GET /api/v1/skills/<target> accepts either. Public for PUBLIC skills (optional
// auth). Used to show the real name (never a raw UUID) before download and to
// name the install directory.
export async function getSkillMeta(target: string): Promise<SkillMeta> {
	const res = await skillhubFetch(
		`/api/v1/skills/${encodeURIComponent(target)}`,
		{ label: "skillhub.detail", optionalAuth: true },
	);
	if (res.status === 404) {
		throw new Error(`Skill "${target}" not found or not public.`);
	}
	if (!res.ok) {
		throw new Error(`Skill lookup failed (${res.status}).`);
	}
	const body = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		data?: { id?: string; name?: string; version?: string };
	};
	if (!body.success || !body.data?.id || !body.data.name) {
		throw new Error("SkillHub returned an unexpected response.");
	}
	return {
		id: body.data.id,
		name: body.data.name,
		version: body.data.version,
	};
}

// Download a skill's ZIP by id. Public for PUBLIC skills (optional auth); a
// stored session is attached when present so a private-namespace skill the user
// can see also downloads. Returns the raw ZIP bytes; 404 → a clear
// not-found/not-public error.
export async function downloadSkill(id: string): Promise<Buffer> {
	const res = await skillhubFetch(`/api/v1/skills/${id}/download`, {
		label: "skillhub.download",
		optionalAuth: true,
	});
	if (res.status === 404) {
		throw new Error(`Skill "${id}" not found or not public.`);
	}
	if (!res.ok) {
		throw new Error(`Download failed (${res.status}).`);
	}
	return Buffer.from(await res.arrayBuffer());
}
