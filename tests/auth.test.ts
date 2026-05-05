import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthData,
	browserOpener,
	loadAuth,
	login,
	logout,
} from "@/auth.js";

const SUPABASE_URL = "https://test.supabase.co";

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;

const VALID_AUTH: AuthData = {
	access_token: "test-access-token",
	id_token: "test-id-token",
	expires_at: Date.now() + 3600000,
	user: {
		sub: "testuser",
		email: "test@example.com",
		displayName: "Test User",
	},
};

const EXPIRED_AUTH: AuthData = {
	...VALID_AUTH,
	expires_at: Date.now() - 1000,
};

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-auth-test-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
	process.env.CODEV_SUPABASE_URL = SUPABASE_URL;
	process.env.CODEV_SUPABASE_ANON_KEY = "anon";
});

afterEach(() => {
	homedirSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
	delete process.env.CODEV_SUPABASE_URL;
	delete process.env.CODEV_SUPABASE_ANON_KEY;
});

function writeAuthFile(data: AuthData) {
	const dir = join(tempDir, ".codev");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(data, null, 2));
}

function mockAuthFetch() {
	const originalFetch = globalThis.fetch;
	return spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url =
			typeof input === "string" || input instanceof URL
				? String(input)
				: input.url;
		if (url.includes("/auth/v1/token?grant_type=pkce")) {
			expect(init?.headers).toMatchObject({ apikey: "anon" });
			return new Response(
				JSON.stringify({
					access_token: "flow-access-token",
					refresh_token: "flow-refresh-token",
					expires_in: 3600,
					user: {
						id: "flowuser",
						email: "flow@example.com",
						user_metadata: { full_name: "Flow User" },
					},
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
			return new Response(
				JSON.stringify({
					access_token: "refresh-access-token",
					refresh_token: "refresh-token-2",
					expires_in: 3600,
					user: { id: "u", email: "refresh@example.com", user_metadata: {} },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		return originalFetch(input, init);
	}) as typeof fetch);
}

describe("loadAuth", () => {
	test("returns auth data when file exists and is not expired", () => {
		writeAuthFile(VALID_AUTH);
		expect(loadAuth()?.access_token).toBe("test-access-token");
	});

	test("returns null when file does not exist", () => {
		expect(loadAuth()).toBeNull();
	});

	test("returns null when token is expired", () => {
		writeAuthFile(EXPIRED_AUTH);
		expect(loadAuth()).toBeNull();
	});

	test("returns null when file contains invalid JSON", () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), "not valid json{{{");
		expect(loadAuth()).toBeNull();
	});
});

describe("logout", () => {
	test("removes the auth file and writes force-login marker", async () => {
		writeAuthFile(VALID_AUTH);
		expect(await logout()).toBe(true);
		expect(loadAuth()).toBeNull();
		expect(existsSync(join(tempDir, ".codev", "force-login"))).toBe(true);
	});

	test("returns false when no auth file exists", async () => {
		expect(await logout()).toBe(false);
	});
});

describe("login", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let openBrowserSpy: ReturnType<typeof spyOn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchSpy = mockAuthFetch();
		openBrowserSpy = spyOn(browserOpener, "open").mockImplementation(() =>
			Promise.resolve(undefined),
		);
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		openBrowserSpy.mockRestore();
	});

	test("returns existing auth when already logged in", async () => {
		writeAuthFile(VALID_AUTH);
		const logs: string[] = [];
		const result = await login(
			(msg) => logs.push(msg),
			() => {},
		);
		expect(result.access_token).toBe("test-access-token");
		expect(logs.some((l) => l.includes("Already logged in"))).toBe(true);
		expect(openBrowserSpy).not.toHaveBeenCalled();
	});

	test("refreshes stale auth with Supabase refresh token", async () => {
		writeAuthFile({ ...EXPIRED_AUTH, refresh_token: "refresh-token" });
		const result = await login(
			() => {},
			() => {},
		);
		expect(result.access_token).toBe("refresh-access-token");
		expect(result.user.email).toBe("refresh@example.com");
	});

	test("uses Supabase custom provider PKCE flow and saves auth", async () => {
		const result = await login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const opened = new URL(openBrowserSpy.mock.calls[0]?.[0] as string);
				expect(opened.origin).toBe(SUPABASE_URL);
				expect(opened.pathname).toBe("/auth/v1/authorize");
				expect(opened.searchParams.get("provider")).toBe("custom:vtnet-oidc");
				expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
				expect(opened.searchParams.get("scopes")).toBe("openid profile email");
				expect(opened.searchParams.get("state")).toBeNull();
				expect(opened.searchParams.get("nonce")).toBeNull();
				const redirectTo = new URL(
					opened.searchParams.get("redirect_to") ?? "",
				);
				setTimeout(() => {
					originalFetch(`http://localhost:${redirectTo.port}/callback?code=c`);
				}, 50);
			},
		);

		expect(result.access_token).toBe("flow-access-token");
		expect(result.refresh_token).toBe("flow-refresh-token");
		expect(result.user.email).toBe("flow@example.com");
		const saved: AuthData = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf8"),
		);
		expect(saved.access_token).toBe("flow-access-token");
	});
});
