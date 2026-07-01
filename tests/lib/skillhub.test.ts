import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SKILLHUB_URL } from "@/lib/const.js";
import {
	adminReviewSkill,
	downloadSkill,
	hasSkillhubAuth,
	listHubSkills,
	SkillhubAuthError,
	saveSkillMetadata,
	skillhubFetch,
	skillhubSignIn,
	submitSkill,
	uploadSkill,
} from "@/lib/skillhub.js";

let tempDir: string;

// Seed ~/.codev/auth.json for the test. A valid (non-expired) SSO session lets
// silentSso() return it without any network call, so the Bearer path is
// exercisable offline.
function seedAuth(contents: Record<string, unknown>): void {
	const dir = join(tempDir, ".codev");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(contents));
}

const VALID_SSO = {
	access_token: "sso-access-token",
	id_token: "sso-id-token",
	expires_at: Date.now() + 3_600_000,
	user: { sub: "emp-1", email: "a@b.c", displayName: "A" },
};

function jsonResponse(
	status: number,
	body: unknown,
	headers?: Headers,
): Response {
	const h = headers ?? new Headers();
	h.set("Content-Type", "application/json");
	return new Response(JSON.stringify(body), { status, headers: h });
}

function lastInit(): RequestInit {
	const spy = globalThis.fetch as unknown as {
		mock: { calls: [unknown, RequestInit][] };
	};
	const call = spy.mock.calls.at(-1);
	if (!call) throw new Error("fetch was not called");
	return call[1];
}

function headersOf(init: RequestInit): Record<string, string> {
	return (init.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-skillhub-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
});

afterEach(() => {
	(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("skillhubFetch auth selection", () => {
	test("sends the stored admin cookie when one exists (no Bearer)", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { success: true }));

		await skillhubFetch("/api/v1/me");

		expect(spy).toHaveBeenCalledTimes(1);
		expect(String(spy.mock.calls[0]?.[0])).toBe(`${SKILLHUB_URL}/api/v1/me`);
		const h = headersOf(lastInit());
		expect(h.Cookie).toBe("skill-hub-session=abc");
		expect(h.Authorization).toBeUndefined();
	});

	test("falls back to the SSO access token as Bearer when no cookie", async () => {
		seedAuth(VALID_SSO);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { success: true }),
		);

		await skillhubFetch("/api/v1/me");

		const h = headersOf(lastInit());
		expect(h.Authorization).toBe("Bearer sso-access-token");
		expect(h.Cookie).toBeUndefined();
	});

	test("throws SkillhubAuthError when neither cookie nor SSO session exists", async () => {
		seedAuth({});
		const spy = vi.spyOn(globalThis, "fetch");

		await expect(skillhubFetch("/api/v1/me")).rejects.toBeInstanceOf(
			SkillhubAuthError,
		);
		expect(spy).not.toHaveBeenCalled();
	});

	test("normalizes a 401 into a SkillhubAuthError with a re-login hint", async () => {
		seedAuth(VALID_SSO);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { success: false, error: "Unauthorized" }),
		);

		await expect(skillhubFetch("/api/v1/me")).rejects.toMatchObject({
			name: "SkillhubAuthError",
			message: expect.stringContaining("codev login"),
		});
	});

	test("returns a 403 response for the caller (not an auth error)", async () => {
		seedAuth(VALID_SSO);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(403, { success: false, error: "forbidden" }),
		);

		const res = await skillhubFetch("/api/v1/admin/review");
		expect(res.status).toBe(403);
	});
});

describe("skillhubSignIn", () => {
	test("returns the name=value cookie (attributes stripped) and the user", async () => {
		seedAuth({});
		const setCookie = new Headers();
		setCookie.append(
			"set-cookie",
			"skill-hub-session=tok123; Path=/; HttpOnly; SameSite=Lax",
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(
				200,
				{
					success: true,
					data: { id: "1", username: "root", role: "SUPERADMIN" },
				},
				setCookie,
			),
		);

		const { cookie, user } = await skillhubSignIn("root", "pw");
		expect(cookie).toBe("skill-hub-session=tok123");
		expect(user).toEqual({ id: "1", username: "root", role: "SUPERADMIN" });
	});

	test("surfaces the server error message on a failed sign-in", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, {
				success: false,
				error: "Invalid username or password",
			}),
		);

		await expect(skillhubSignIn("root", "bad")).rejects.toThrow(
			"Invalid username or password",
		);
	});

	test("throws when sign-in succeeds but no session cookie is returned", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				success: true,
				data: { id: "1", username: "root", role: "ADMIN" },
			}),
		);

		await expect(skillhubSignIn("root", "pw")).rejects.toThrow(
			/no session cookie/i,
		);
	});
});

describe("listHubSkills", () => {
	const HUB = {
		success: true,
		data: [
			{
				id: "id-1",
				name: "pg-tuner",
				provider: "viettel",
				description: "Tune Postgres",
				version: "1.2.0",
				publishedAt: "2026-06-01",
			},
		],
		pagination: { total: 7 },
	};

	test("works logged out (optional auth) and passes search + limit", async () => {
		seedAuth({}); // no cookie, no SSO session
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, HUB));

		const result = await listHubSkills({ search: "postgres", limit: 5 });

		expect(spy).toHaveBeenCalledTimes(1);
		const url = new URL(String(spy.mock.calls[0]?.[0]));
		expect(url.pathname).toBe("/netmindhub/api/v1/hub/skills");
		expect(url.searchParams.get("search")).toBe("postgres");
		expect(url.searchParams.get("limit")).toBe("5");
		// No credential available → no auth header, but no throw either.
		const h = headersOf(lastInit());
		expect(h.Authorization).toBeUndefined();
		expect(h.Cookie).toBeUndefined();

		expect(result.total).toBe(7);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.name).toBe("pg-tuner");
	});

	test("attaches a stored session when one exists", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, HUB));

		await listHubSkills();

		expect(headersOf(lastInit()).Cookie).toBe("skill-hub-session=abc");
	});

	test("falls back to items.length when pagination.total is absent", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { success: true, data: HUB.data }),
		);
		expect((await listHubSkills()).total).toBe(1);
	});

	test("throws on a non-2xx response", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(500, { success: false }),
		);
		await expect(listHubSkills()).rejects.toThrow(/failed \(500\)/);
	});

	test("throws on an unexpected body shape", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { success: false }),
		);
		await expect(listHubSkills()).rejects.toThrow(/unexpected response/i);
	});
});

describe("downloadSkill", () => {
	test("returns the raw ZIP bytes on 200 (public, logged out)", async () => {
		seedAuth({});
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(bytes, { status: 200 }));

		const buf = await downloadSkill("id-1");

		expect(String(spy.mock.calls[0]?.[0])).toBe(
			`${SKILLHUB_URL}/api/v1/skills/id-1/download`,
		);
		expect(Buffer.isBuffer(buf)).toBe(true);
		expect([...buf]).toEqual([0x50, 0x4b, 0x03, 0x04]);
		expect(headersOf(lastInit()).Authorization).toBeUndefined();
	});

	test("gives a not-found/not-public message on 404", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", { status: 404 }),
		);
		await expect(downloadSkill("missing")).rejects.toThrow(
			/not found or not public/i,
		);
	});

	test("throws on other non-2xx", async () => {
		seedAuth({});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("", { status: 500 }),
		);
		await expect(downloadSkill("x")).rejects.toThrow(/failed \(500\)/);
	});
});

describe("uploadSkill", () => {
	test("POSTs multipart form-data and returns the skill_id", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				success: true,
				skill_id: "sk-1",
				status: "PENDING",
			}),
		);

		const res = await uploadSkill(Buffer.from("PK\x03\x04zip"), "pg-tuner.zip");

		expect(res.skill_id).toBe("sk-1");
		expect(String(spy.mock.calls[0]?.[0])).toBe(
			`${SKILLHUB_URL}/api/v1/skills/upload`,
		);
		const init = lastInit();
		expect(init.method).toBe("POST");
		expect(init.body).toBeInstanceOf(FormData);
		// Content-Type must NOT be set by us — fetch adds the multipart boundary.
		expect(headersOf(init)["Content-Type"]).toBeUndefined();
		// Cookie still rides along via skillhubFetch.
		expect(headersOf(init).Cookie).toBe("skill-hub-session=abc");
	});

	test("throws the server message when success is false", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(400, { success: false, message: "name already taken" }),
		);
		await expect(uploadSkill(Buffer.from("z"), "x.zip")).rejects.toThrow(
			"name already taken",
		);
	});
});

describe("saveSkillMetadata", () => {
	test("PATCHes the metadata endpoint with the JSON body", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { success: true }));

		await saveSkillMetadata("sk-1");

		expect(String(spy.mock.calls[0]?.[0])).toBe(
			`${SKILLHUB_URL}/api/v1/skills/sk-1/metadata`,
		);
		const init = lastInit();
		expect(init.method).toBe("PATCH");
		expect(init.body).toBe("{}");
		expect(headersOf(init)["Content-Type"]).toBe("application/json");
	});

	test("throws on a failure response", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(500, { success: false, message: "boom" }),
		);
		await expect(saveSkillMetadata("sk-1")).rejects.toThrow("boom");
	});
});

describe("submitSkill", () => {
	test("PATCHes the submit endpoint", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { success: true }));

		await submitSkill("sk-1");

		expect(String(spy.mock.calls[0]?.[0])).toBe(
			`${SKILLHUB_URL}/api/v1/skills/sk-1/submit`,
		);
		expect(lastInit().method).toBe("PATCH");
	});

	test("throws on a failure response", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(409, { success: false, message: "wrong status" }),
		);
		await expect(submitSkill("sk-1")).rejects.toThrow("wrong status");
	});
});

describe("adminReviewSkill", () => {
	test("POSTs the review action with skill_id and feedback", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { success: true }));

		await adminReviewSkill("sk-1", "APPROVE", "ok");

		expect(String(spy.mock.calls[0]?.[0])).toBe(
			`${SKILLHUB_URL}/api/v1/admin/review`,
		);
		const init = lastInit();
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({
			skill_id: "sk-1",
			action: "APPROVE",
			feedback: "ok",
		});
	});

	test("throws the server message when a non-admin is forbidden (403)", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(403, { success: false, message: "admin only" }),
		);
		await expect(adminReviewSkill("sk-1", "APPROVE")).rejects.toThrow(
			"admin only",
		);
	});
});

describe("hasSkillhubAuth", () => {
	test("true when an admin cookie is stored (no network)", async () => {
		seedAuth({ skillhub_cookie: "skill-hub-session=abc" });
		const spy = vi.spyOn(globalThis, "fetch");
		expect(await hasSkillhubAuth()).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});

	test("true when a valid SSO session exists", async () => {
		seedAuth(VALID_SSO);
		expect(await hasSkillhubAuth()).toBe(true);
	});

	test("false when logged out (no cookie, no SSO session)", async () => {
		seedAuth({});
		expect(await hasSkillhubAuth()).toBe(false);
	});
});
