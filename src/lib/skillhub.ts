import { loadSkillhubCookie, silentSso } from "@/lib/auth.js";
import { SKILLHUB_URL } from "@/lib/const.js";
import { loggedFetch } from "@/lib/log.js";

// SkillHub handshakes are quick JSON requests — cap them so a stalled registry
// surfaces as an error instead of hanging the CLI.
const SKILLHUB_TIMEOUT_MS = 15_000;
// A skill upload ships an entire ZIP — allow much longer than a handshake.
const SKILLHUB_UPLOAD_TIMEOUT_MS = 120_000;
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

// True when a SkillHub credential is available without prompting the user — a
// stored admin cookie, or an SSO session (refreshed silently if the access token
// expired). Mirrors the credential selection in skillhubFetch, so `skill push`
// can offer an interactive login only when the user is genuinely logged out.
// Never throws.
export async function hasSkillhubAuth(): Promise<boolean> {
	if (loadSkillhubCookie()) return true;
	try {
		return (await silentSso()) !== null;
	} catch {
		return false;
	}
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

// Server response to a skill upload. The skill lands in PENDING; `skill_id`
// identifies it for the metadata/submit steps that follow.
export interface UploadResponse {
	success: boolean;
	skill_id?: string;
	status?: string;
	message?: string;
	errors?: { code: string; message: string; field?: string }[];
}

// Upload a skill ZIP (multipart) — POST /api/v1/skills/upload. Auth is required.
// Content-Type is intentionally left unset so fetch adds the multipart boundary;
// a longer timeout than the JSON handshake accommodates a real archive.
export async function uploadSkill(
	zipBuffer: Buffer,
	fileName: string,
): Promise<UploadResponse> {
	const blob = new Blob([new Uint8Array(zipBuffer)], {
		type: "application/zip",
	});
	const form = new FormData();
	form.append("file", blob, fileName);

	const res = await skillhubFetch("/api/v1/skills/upload", {
		label: "skillhub.upload",
		method: "POST",
		body: form,
		signal: AbortSignal.timeout(SKILLHUB_UPLOAD_TIMEOUT_MS),
	});
	const body = (await res.json().catch(() => ({}))) as UploadResponse;
	if (!res.ok || !body.success) {
		throw new Error(body.message ?? `Upload failed (${res.status}).`);
	}
	return body;
}

// Save a skill's metadata — PATCH /api/v1/skills/<id>/metadata. An empty body is
// enough to flip the freshly-uploaded skill from PENDING to DRAFT; the server
// derives the real metadata from the ZIP's SKILL.md.
export async function saveSkillMetadata(
	skillId: string,
	payload: Record<string, unknown> = {},
): Promise<void> {
	const res = await skillhubFetch(`/api/v1/skills/${skillId}/metadata`, {
		label: "skillhub.metadata",
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const body = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		message?: string;
	};
	if (!res.ok || !body.success) {
		throw new Error(body.message ?? `Saving metadata failed (${res.status}).`);
	}
}

// Submit a DRAFT skill for review — PATCH /api/v1/skills/<id>/submit. Moves it
// to SUBMITTED and notifies admins.
export async function submitSkill(skillId: string): Promise<void> {
	const res = await skillhubFetch(`/api/v1/skills/${skillId}/submit`, {
		label: "skillhub.submit",
		method: "PATCH",
	});
	const body = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		message?: string;
	};
	if (!res.ok || !body.success) {
		throw new Error(body.message ?? `Submit failed (${res.status}).`);
	}
}

// Admin-only review action — POST /api/v1/admin/review. Approving a SUBMITTED
// skill publishes it (PUBLIC). A non-admin caller gets a 403 here, surfaced as
// the server's message.
export async function adminReviewSkill(
	skillId: string,
	action: "APPROVE" | "REJECT",
	feedback?: string,
): Promise<void> {
	const res = await skillhubFetch("/api/v1/admin/review", {
		label: "skillhub.review",
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ skill_id: skillId, action, feedback }),
	});
	const body = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		message?: string;
	};
	if (!res.ok || !body.success) {
		throw new Error(body.message ?? `Review failed (${res.status}).`);
	}
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
