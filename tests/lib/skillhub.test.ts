import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	loadApiKey,
	loadSkillhubSession,
	logout,
	saveSkillhubSession,
} from "@/lib/auth.js";
import {
	browserOpener,
	captureSkillhubSession,
	normalizeSessionCookie,
} from "@/lib/skillhub.js";

const REGISTRY = "https://hub.test";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-skillhub-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	vi.stubEnv("SKILLHUB_REGISTRY", REGISTRY);
	// Make sure neither escape hatch is set by the ambient environment.
	vi.stubEnv("CODEV_BYPASS_LOGIN", "");
	vi.stubEnv("CODEV_SKIP_SKILLHUB", "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

// A browser stub that drives the loopback the way the real consent page does:
// it reads the `cb`/`state` from the authorize URL and POSTs the cookie back.
function driveBrowser(token: string, realFetch: typeof fetch) {
	return vi.spyOn(browserOpener, "open").mockImplementation(async (url) => {
		const u = new URL(url);
		const cb = u.searchParams.get("cb");
		const state = u.searchParams.get("state");
		if (cb && state) {
			await realFetch(cb, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ state, token }),
			});
		}
		return undefined;
	});
}

function meResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("normalizeSessionCookie", () => {
	test("accepts a bare value", () => {
		expect(normalizeSessionCookie("abc123")).toBe("skill-hub-session=abc123");
	});

	test("accepts a name=value pair", () => {
		expect(normalizeSessionCookie("skill-hub-session=abc123")).toBe(
			"skill-hub-session=abc123",
		);
	});

	test("extracts ours from a full Set-Cookie line", () => {
		expect(
			normalizeSessionCookie("skill-hub-session=abc; Path=/; HttpOnly"),
		).toBe("skill-hub-session=abc");
	});

	test("finds ours when a different cookie is pasted first", () => {
		expect(
			normalizeSessionCookie("other=x; skill-hub-session=abc; Path=/"),
		).toBe("skill-hub-session=abc");
	});

	test("strips a leading Cookie: prefix", () => {
		expect(normalizeSessionCookie("Cookie: skill-hub-session=abc")).toBe(
			"skill-hub-session=abc",
		);
	});

	test("returns null for empty / unrecognizable input", () => {
		expect(normalizeSessionCookie("")).toBeNull();
		expect(normalizeSessionCookie("   ")).toBeNull();
		expect(normalizeSessionCookie("other=x")).toBeNull();
	});
});

describe("captureSkillhubSession", () => {
	test("captures a fresh session and saves it to auth.json", async () => {
		const realFetch = globalThis.fetch;
		const openSpy = driveBrowser("sess-abc", realFetch);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = String(input);
			if (url === `${REGISTRY}/api/v1/me`) {
				return meResponse(200, {
					success: true,
					data: { username: "alice", role: "USER" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch);

		const logs: string[] = [];
		await captureSkillhubSession((m) => logs.push(m));

		expect(openSpy).toHaveBeenCalledTimes(1);
		const saved = loadSkillhubSession();
		expect(saved?.cookie).toBe("skill-hub-session=sess-abc");
		expect(saved?.registry).toBe(REGISTRY);
		expect(saved?.user.username).toBe("alice");
		expect(logs.join("\n")).toContain("connected as alice");
	});

	test("reuses a still-valid saved cookie without opening a browser", async () => {
		saveSkillhubSession({
			registry: REGISTRY,
			cookie: "skill-hub-session=cached",
			user: { username: "bob", role: "ADMIN" },
		});
		const openSpy = vi.spyOn(browserOpener, "open");
		vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			meResponse(200, {
				success: true,
				data: { username: "bob", role: "ADMIN" },
			})) as typeof fetch);

		const logs: string[] = [];
		await captureSkillhubSession((m) => logs.push(m));

		expect(openSpy).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("already connected as bob");
	});

	test("re-captures when the saved cookie no longer validates", async () => {
		saveSkillhubSession({
			registry: REGISTRY,
			cookie: "skill-hub-session=stale",
			user: { username: "bob", role: "ADMIN" },
		});
		const realFetch = globalThis.fetch;
		const openSpy = driveBrowser("sess-new", realFetch);
		let meCall = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = String(input);
			if (url === `${REGISTRY}/api/v1/me`) {
				meCall += 1;
				// First call (validating the stale cookie) fails; second (the
				// freshly captured cookie) succeeds.
				return meCall === 1
					? meResponse(401, { success: false })
					: meResponse(200, {
							success: true,
							data: { username: "carol", role: "USER" },
						});
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof fetch);

		await captureSkillhubSession(() => {});

		expect(openSpy).toHaveBeenCalledTimes(1);
		expect(loadSkillhubSession()?.cookie).toBe("skill-hub-session=sess-new");
	});

	test("warns and continues (no throw, no save) when verification fails", async () => {
		const realFetch = globalThis.fetch;
		driveBrowser("sess-bad", realFetch);
		vi.spyOn(globalThis, "fetch").mockImplementation((async () =>
			meResponse(401, { success: false })) as typeof fetch);

		const logs: string[] = [];
		await expect(
			captureSkillhubSession((m) => logs.push(m)),
		).resolves.toBeUndefined();

		expect(loadSkillhubSession()).toBeNull();
		expect(logs.join("\n")).toContain("not connected");
	});

	test("is a no-op when CODEV_SKIP_SKILLHUB=1", async () => {
		vi.stubEnv("CODEV_SKIP_SKILLHUB", "1");
		const openSpy = vi.spyOn(browserOpener, "open");
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await captureSkillhubSession(() => {});

		expect(openSpy).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(loadSkillhubSession()).toBeNull();
	});

	test("is a no-op when CODEV_BYPASS_LOGIN=1", async () => {
		vi.stubEnv("CODEV_BYPASS_LOGIN", "1");
		const openSpy = vi.spyOn(browserOpener, "open");

		await captureSkillhubSession(() => {});

		expect(openSpy).not.toHaveBeenCalled();
		expect(loadSkillhubSession()).toBeNull();
	});
});

describe("logout × SkillHub session", () => {
	function seedAuthFile(contents: Record<string, unknown>) {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), JSON.stringify(contents, null, 2));
	}

	test("clears the SkillHub session but preserves the gateway api key", async () => {
		seedAuthFile({
			access_token: "a",
			id_token: "i",
			refresh_token: "r",
			expires_at: Date.now() + 3_600_000,
			user: { sub: "u", email: "e@example.com", displayName: "E" },
			api_key: "key-123",
			skillhub_cookie: "skill-hub-session=abc",
			skillhub_registry: REGISTRY,
			skillhub_user: { username: "alice", role: "USER" },
		});
		// Token revocation during logout is best-effort; stub it so we don't hit
		// the network.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 200 }),
		);

		const ok = await logout();

		expect(ok).toBe(true);
		expect(loadSkillhubSession()).toBeNull();
		expect(loadApiKey()?.apiKey).toBe("key-123");
	});
});
