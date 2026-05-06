import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_URL } from "@/const.js";
import {
	fetchApiKey,
	fetchCodevConfig,
	fetchSupabaseSession,
	validateApiKey,
} from "@/proxy.js";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("fetchApiKey", () => {
	test("returns the api_key on a 2xx response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				api_key: "sk-abc",
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		expect(await fetchApiKey("token")).toBe("sk-abc");
	});

	test("returns an empty string when api_key is empty", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				api_key: "",
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		expect(await fetchApiKey("token")).toBe("");
	});

	test("returns an empty string when api_key is missing", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		expect(await fetchApiKey("token")).toBe("");
	});

	test("throws on a non-2xx response with the proxy-supplied error", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(502, { error: "upstream timeout" }),
		);
		await expect(fetchApiKey("token")).rejects.toThrow(
			"Proxy /auth/exchange failed (502): upstream timeout",
		);
	});

	test("throws on a non-2xx response with no JSON body, using statusText", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not json", { status: 500, statusText: "Server Error" }),
		);
		await expect(fetchApiKey("token")).rejects.toThrow(
			"Proxy /auth/exchange failed (500): Server Error",
		);
	});

	test("sends the access token as a Bearer Authorization header", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				api_key: "sk-abc",
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		await fetchApiKey("my-token");
		const [, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(init.method).toBe("POST");
		expect(init.headers?.Authorization).toBe("Bearer my-token");
	});
});

describe("validateApiKey", () => {
	test("returns true on a 2xx response from /key/info", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { key: "sk-abc", spend: 0 }),
		);
		await expect(validateApiKey("sk-abc")).resolves.toBe(true);

		const [url, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(url).toBe(`${BASE_URL}gateway/key/info`);
		expect(init.method).toBe("GET");
		expect(init.headers?.Authorization).toBe("Bearer sk-abc");
	});

	test("returns false on 401", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Authentication Error", { status: 401 }),
		);
		await expect(validateApiKey("sk-bad")).resolves.toBe(false);
	});

	test("returns false on 403", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Forbidden", { status: 403 }),
		);
		await expect(validateApiKey("sk-bad")).resolves.toBe(false);
	});

	test("throws on a 5xx response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("oops", { status: 500, statusText: "Server Error" }),
		);
		await expect(validateApiKey("sk-x")).rejects.toThrow(
			"Validation failed (500): Server Error",
		);
	});

	test("throws on network error", async () => {
		spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("fetch failed: ECONNREFUSED"),
		);
		await expect(validateApiKey("sk-x")).rejects.toThrow("ECONNREFUSED");
	});

	test("strips a trailing /v1 from the baseUrl when targeting /key/info", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {}),
		);
		await validateApiKey("sk-y", "https://my-gw.example.com/v1");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://my-gw.example.com/key/info");
	});

	test("handles a baseUrl without /v1", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {}),
		);
		await validateApiKey("sk-z", "https://gw.example.com/");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://gw.example.com/key/info");
	});
});

describe("fetchSupabaseSession", () => {
	let tempHome: string;
	let homedirSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-proxy-test-")));
		mkdirSync(join(tempHome, ".codev"), { recursive: true });
		writeFileSync(
			join(tempHome, ".codev", "auth.json"),
			JSON.stringify({
				supabase_url: "https://test.supabase.co",
				supabase_anon_key: "anon",
				supabase_proxy_url: "https://api.test/api/codev",
			}),
		);
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	});

	afterEach(() => {
		homedirSpy.mockRestore();
		rmSync(tempHome, { recursive: true, force: true });
	});

	test("posts to the configured supabase proxy URL", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				access_token: "supabase-token",
				user: { id: "uid", email: "x@y.z" },
			}),
		);
		await fetchSupabaseSession("sso-token");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://api.test/api/codev/supabase/exchange");
	});

	test("returns the Supabase session on a 2xx response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				access_token: "supabase-token",
				refresh_token: "refresh",
				expires_at: 123,
				user: { id: "uid", email: "x@y.z" },
			}),
		);
		expect(await fetchSupabaseSession("sso-token")).toEqual({
			access_token: "supabase-token",
			refresh_token: "refresh",
			expires_at: 123,
			user: { id: "uid", email: "x@y.z" },
		});
	});

	test("throws on a non-2xx response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { error: "invalid sso token" }),
		);
		await expect(fetchSupabaseSession("bad-token")).rejects.toThrow(
			"Proxy /supabase/exchange failed (401): invalid sso token",
		);
	});

	test("throws with hard-fail message when supabase_proxy_url is missing", async () => {
		writeFileSync(join(tempHome, ".codev", "auth.json"), JSON.stringify({}));
		await expect(fetchSupabaseSession("token")).rejects.toThrow(
			/Run `codev install`/,
		);
	});
});

describe("fetchCodevConfig", () => {
	test("returns the three Supabase coordinates on a 2xx response", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				supabaseUrl: "https://x.supabase.co",
				supabaseAnonKey: "anon",
				supabaseProxyUrl: "https://api.test/api/codev",
			}),
		);
		expect(await fetchCodevConfig("sso-token")).toEqual({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon",
			supabaseProxyUrl: "https://api.test/api/codev",
		});
	});

	test("posts to the codev-proxy /config endpoint with a Bearer token", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				supabaseUrl: "u",
				supabaseAnonKey: "a",
				supabaseProxyUrl: "p",
			}),
		);
		await fetchCodevConfig("my-token");
		const [url, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(url).toBe(`${BASE_URL}codev-proxy/config`);
		expect(init.method).toBe("POST");
		expect(init.headers?.Authorization).toBe("Bearer my-token");
	});

	test("throws on a non-2xx response with the proxy-supplied error", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { error: "invalid sso" }),
		);
		await expect(fetchCodevConfig("bad")).rejects.toThrow(
			"Proxy /config failed (401): invalid sso",
		);
	});

	test("throws when the response is missing required fields", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { supabaseUrl: "only-this" }),
		);
		await expect(fetchCodevConfig("token")).rejects.toThrow(
			/incomplete payload/,
		);
	});
});
