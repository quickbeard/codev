import { loadAuth } from "@/lib/auth.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";

export interface HubSkill {
	id: string;
	name: string;
	description: string | null;
	version: string;
	author: { name: string; username: string } | null;
	downloadCount: number;
}

export type SkillStatus =
	| "DRAFT"
	| "PENDING"
	| "PRIVATE"
	| "SUBMITTED"
	| "PUBLIC"
	| "REJECTED"
	| "DELETED";

export interface MySkill {
	id: string;
	name: string;
	version: string;
	status: SkillStatus;
	description: string | null;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	reviews: Array<{
		action: "APPROVE" | "REJECT";
		feedback: string | null;
		createdAt: string;
	}>;
}

export interface HubNamespace {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	status: "ACTIVE" | "FROZEN" | "ARCHIVED";
	isPublic: boolean;
	userRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
	skillCount: number;
	memberCount: number;
}

export interface NamespaceSkill {
	id: string;
	name: string;
	version: string;
	status: SkillStatus;
	author: {
		username: string;
		firstName: string | null;
		lastName: string | null;
	} | null;
	addedAt: string;
}

function requireToken(): string {
	const auth = loadAuth();
	if (!auth) throw new Error("Not logged in. Run `codev login` first.");
	return auth.access_token;
}

export async function searchSkills(
	query?: string,
	limit = 20,
): Promise<HubSkill[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	if (query) params.set("search", query);
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/hub/skills?${params}`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`SkillHub returned ${res.status}`);
	const data = (await res.json()) as {
		data: HubSkill[];
		pagination: { total: number };
	};
	return data.data ?? [];
}

export async function downloadSkill(id: string): Promise<Buffer> {
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/skills/${id}/download`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

export async function downloadSkillVersion(
	slug: string,
	version: string,
): Promise<Buffer> {
	const res = await fetch(
		`${SKILLHUB_REGISTRY}/api/v1/download/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (!res.ok)
		throw new Error(
			`Version "${version}" not found for skill "${slug}" (${res.status})`,
		);
	return Buffer.from(await res.arrayBuffer());
}

export async function getMySkills(): Promise<MySkill[]> {
	const token = requireToken();
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/me/skills`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`SkillHub returned ${res.status}`);
	const data = (await res.json()) as { data: MySkill[] };
	return data.data ?? [];
}

export async function getMyNamespaces(): Promise<HubNamespace[]> {
	const token = requireToken();
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/namespaces`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`SkillHub returned ${res.status}`);
	const data = (await res.json()) as { data: HubNamespace[] };
	return data.data ?? [];
}

export async function getNamespaceSkills(
	slug: string,
): Promise<NamespaceSkill[]> {
	const token = requireToken();
	const res = await fetch(
		`${SKILLHUB_REGISTRY}/api/v1/namespaces/${slug}/skills`,
		{
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!res.ok) throw new Error(`SkillHub returned ${res.status}`);
	const data = (await res.json()) as { data: NamespaceSkill[] };
	return data.data ?? [];
}

export async function uploadSkill(
	zipBuffer: Buffer,
	filename: string,
	namespaceSlug?: string,
): Promise<string> {
	const token = requireToken();
	const formData = new FormData();
	formData.append(
		"file",
		new Blob([new Uint8Array(zipBuffer)], { type: "application/zip" }),
		filename,
	);
	if (namespaceSlug) formData.append("namespaceSlug", namespaceSlug);
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/skills/upload`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: formData,
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) {
		const body = await res.text();
		let msg = `Upload failed (${res.status})`;
		try {
			const parsed = JSON.parse(body) as {
				error?: string;
				message?: string;
				details?: unknown;
				errors?: unknown;
				validationErrors?: unknown;
			};
			const base = parsed.error ?? parsed.message ?? msg;
			const extra =
				parsed.details ?? parsed.errors ?? parsed.validationErrors ?? null;
			if (extra !== null && extra !== undefined) {
				const extraStr = Array.isArray(extra)
					? extra
							.map((e) =>
								typeof e === "object" ? JSON.stringify(e) : String(e),
							)
							.join("; ")
					: typeof extra === "object"
						? JSON.stringify(extra)
						: String(extra);
				msg = `${base}\n${extraStr}`;
			} else {
				msg = base;
			}
		} catch {
			if (body) msg = body;
		}
		throw new Error(msg);
	}
	const data = (await res.json()) as { skill_id: string };
	return data.skill_id;
}

export async function saveSkillMetadata(id: string): Promise<void> {
	const token = requireToken();
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/skills/${id}/metadata`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`Save metadata failed (${res.status})`);
}

export interface UserProfile {
	id: string;
	username: string;
	firstName: string | null;
	lastName: string | null;
	jobTitle: string | null;
	department: string | null;
	centerName: string | null;
	companyName: string | null;
	joinedAt: string;
	stats: { publicSkills: number; totalDownloads: number; totalStars: number };
}

export interface UserSkill {
	id: string;
	name: string;
	description: string | null;
	version: string;
	stars: number;
	downloadCount: number;
}

export interface LeaderboardSkill {
	id: string;
	name: string;
	description: string | null;
	stars: number;
	downloadCount: number;
	author: { username: string; firstName: string | null } | null;
}

export interface LeaderboardContributor {
	authorId: string;
	displayName: string;
	username: string;
	deptName: string | null;
	centerName: string | null;
	skillCount: number;
	totalStars: number;
	totalDownloads: number;
	score: number;
}

export interface Leaderboard {
	topRated: LeaderboardSkill[];
	trending: LeaderboardSkill[];
	mostDownloaded: LeaderboardSkill[];
	contributors: LeaderboardContributor[];
}

export async function getUserProfile(username: string): Promise<UserProfile> {
	const res = await fetch(
		`${SKILLHUB_REGISTRY}/api/v1/users/${encodeURIComponent(username)}`,
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!res.ok) throw new Error(`User not found: ${username}`);
	const data = (await res.json()) as { data: UserProfile };
	return data.data;
}

export async function getUserSkills(username: string): Promise<UserSkill[]> {
	const res = await fetch(
		`${SKILLHUB_REGISTRY}/api/v1/users/${encodeURIComponent(username)}/skills`,
		{ signal: AbortSignal.timeout(10_000) },
	);
	if (!res.ok) throw new Error(`Could not fetch skills for ${username}`);
	const data = (await res.json()) as { data: UserSkill[] };
	return data.data ?? [];
}

export async function getLeaderboard(): Promise<Leaderboard> {
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/leaderboard`, {
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`Leaderboard unavailable (${res.status})`);
	const data = (await res.json()) as { data: Leaderboard };
	return data.data;
}

export async function submitSkill(id: string): Promise<void> {
	const token = requireToken();
	const res = await fetch(`${SKILLHUB_REGISTRY}/api/v1/skills/${id}/submit`, {
		method: "PATCH",
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`Submit failed (${res.status})`);
}
