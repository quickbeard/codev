import { afterEach, describe, expect, test, vi } from "vitest";
import { AI_GATEWAY_URL, PROXY_URL } from "@/lib/const.js";
import {
	fetchApiKey,
	fetchCodevConfig,
	fetchSupabaseSession,
	validateApiKey,
} from "@/lib/proxy.js";

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
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				api_key: "sk-abc",
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		expect(await fetchApiKey("token")).toBe("sk-abc");
	});

	test("returns an empty string when api_key is empty", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				api_key: "",
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		expect(await fetchApiKey("token")).toBe("");
	});

	test("returns an empty string when api_key is missing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				user: { sub: "u", email: "x@y.z", displayName: "X" },
			}),
		);
		expect(await fetchApiKey("token")).toBe("");
	});

	test("throws on a non-2xx response with the proxy-supplied error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(502, { error: "upstream timeout" }),
		);
		await expect(fetchApiKey("token")).rejects.toThrow(
			"Proxy /auth/exchange failed (502): upstream timeout",
		);
	});

	test("throws on a non-2xx response with no JSON body, using statusText", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not json", { status: 500, statusText: "Server Error" }),
		);
		await expect(fetchApiKey("token")).rejects.toThrow(
			"Proxy /auth/exchange failed (500): Server Error",
		);
	});

	test("sends the access token as a Bearer Authorization header", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { key: "sk-abc", spend: 0 }));
		await expect(validateApiKey("sk-abc")).resolves.toBe(true);

		const [url, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(url).toBe(`${AI_GATEWAY_URL}/key/info`);
		expect(init.method).toBe("GET");
		expect(init.headers?.Authorization).toBe("Bearer sk-abc");
	});

	test("returns false on 401", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Authentication Error", { status: 401 }),
		);
		await expect(validateApiKey("sk-bad")).resolves.toBe(false);
	});

	test("returns false on 403", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("Forbidden", { status: 403 }),
		);
		await expect(validateApiKey("sk-bad")).resolves.toBe(false);
	});

	test("throws on a 5xx response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("oops", { status: 500, statusText: "Server Error" }),
		);
		await expect(validateApiKey("sk-x")).rejects.toThrow(
			"Validation failed (500): Server Error",
		);
	});

	test("throws on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("fetch failed: ECONNREFUSED"),
		);
		await expect(validateApiKey("sk-x")).rejects.toThrow("ECONNREFUSED");
	});

	test("strips a trailing /v1 from the baseUrl when targeting /key/info", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, {}));
		await validateApiKey("sk-y", "https://my-gw.example.com/v1");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://my-gw.example.com/key/info");
	});

	test("handles a baseUrl without /v1", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, {}));
		await validateApiKey("sk-z", "https://gw.example.com/");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://gw.example.com/key/info");
	});

	test("inserts the path separator when AI_GATEWAY_URL has no trailing slash", async () => {
		// Regression: keyInfoUrl(undefined) used to produce ".../gatewaykey/info"
		// because it concatenated AI_GATEWAY_URL (no trailing slash) directly
		// with "key/info". SSO-fetched keys have no base_url, so they hit this
		// fallback — and the malformed URL made validateApiKey throw, hiding
		// the "use existing API key" option even when the key was valid.
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, {}));
		await validateApiKey("sk-w");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).not.toContain("gatewaykey");
		expect(url.endsWith("/gateway/key/info")).toBe(true);
	});
});

describe("fetchSupabaseSession", () => {
	test("posts to the codev-proxy /supabase/exchange endpoint", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				access_token: "supabase-token",
				user: { id: "uid", email: "x@y.z" },
			}),
		);
		await fetchSupabaseSession("sso-token");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe(`${PROXY_URL}/supabase/exchange`);
	});

	test("returns the Supabase session on a 2xx response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { error: "invalid sso token" }),
		);
		await expect(fetchSupabaseSession("bad-token")).rejects.toThrow(
			"Proxy /supabase/exchange failed (401): invalid sso token",
		);
	});
});

describe("fetchCodevConfig", () => {
	test("returns the Supabase coordinates on a 2xx response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				supabaseUrl: "https://x.supabase.co",
				supabaseAnonKey: "anon",
			}),
		);
		expect(await fetchCodevConfig("sso-token")).toEqual({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon",
		});
	});

	test("posts to the codev-proxy /config endpoint with a Bearer token", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				supabaseUrl: "u",
				supabaseAnonKey: "a",
			}),
		);
		await fetchCodevConfig("my-token");
		const [url, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(url).toBe(`${PROXY_URL}/config`);
		expect(init.method).toBe("POST");
		expect(init.headers?.Authorization).toBe("Bearer my-token");
	});

	test("throws on a non-2xx response with the proxy-supplied error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { error: "invalid sso" }),
		);
		await expect(fetchCodevConfig("bad")).rejects.toThrow(
			"Proxy /config failed (401): invalid sso",
		);
	});

	test("throws when the response is missing required fields", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { supabaseUrl: "only-this" }),
		);
		await expect(fetchCodevConfig("token")).rejects.toThrow(
			/incomplete payload/,
		);
	});
});
