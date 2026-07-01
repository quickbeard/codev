import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SKILLHUB_URL } from "@/lib/const.js";
import {
	SkillhubAuthError,
	skillhubFetch,
	skillhubSignIn,
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
