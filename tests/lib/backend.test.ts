import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	fetchApiKey,
	fetchCodevConfig,
	fetchModels,
	fetchSupabaseSession,
	isInvalidKeyError,
	smokeTestModel,
	validateApiKey,
} from "@/lib/backend.js";
import {
	AI_GATEWAY_OPENAI_URL,
	AI_GATEWAY_URL,
	BACKEND_URL,
} from "@/lib/const.js";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// The gateway-URL accessors (AI_GATEWAY_URL / AI_GATEWAY_OPENAI_URL) read the
// cached gateway_url out of ~/.codev-hub/auth.json. backend.ts falls back to them
// whenever a call has no explicit baseUrl (the SSO-key path), so every test in
// this file gets a temp HOME with a known gateway_url seeded.
const GATEWAY_URL = "https://gw.test/gateway";
let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-backend-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	const dir = join(tempDir, ".codev-hub");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ gateway_url: GATEWAY_URL }),
	);
});

afterEach(() => {
	(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
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

	test("throws on a non-2xx response with the backend-supplied error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(502, { error: "upstream timeout" }),
		);
		await expect(fetchApiKey("token")).rejects.toThrow(
			"Backend /auth/exchange failed (502): upstream timeout",
		);
	});

	test("throws on a non-2xx response with no JSON body, using statusText", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not json", { status: 500, statusText: "Server Error" }),
		);
		await expect(fetchApiKey("token")).rejects.toThrow(
			"Backend /auth/exchange failed (500): Server Error",
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
		expect(url).toBe(`${AI_GATEWAY_URL()}/key/info`);
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
		expect(url.endsWith("/gateway/key/info")).toBe(true);
	});
});

describe("fetchModels", () => {
	test("returns the list of model ids from the gateway /v1/models", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				data: [{ id: "model-a" }, { id: "model-b" }],
			}),
		);
		await expect(fetchModels("sk-test")).resolves.toEqual([
			"model-a",
			"model-b",
		]);

		const [url, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(url).toBe(`${AI_GATEWAY_OPENAI_URL()}/models`);
		expect(init.method).toBe("GET");
		expect(init.headers?.Authorization).toBe("Bearer sk-test");
		expect(init.headers?.accept).toBe("application/json");
	});

	test("throws on 401 with the gateway-supplied error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { error: "invalid key" }),
		);
		await expect(fetchModels("sk-bad")).rejects.toThrow(
			"Models fetch failed (401): invalid key",
		);
	});

	test("throws on 5xx using statusText when no JSON body", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("oops", { status: 503, statusText: "Service Unavailable" }),
		);
		await expect(fetchModels("sk-x")).rejects.toThrow(
			"Models fetch failed (503): Service Unavailable",
		);
	});

	test("throws on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("fetch failed: ECONNREFUSED"),
		);
		await expect(fetchModels("sk-x")).rejects.toThrow("ECONNREFUSED");
	});

	test("throws when the gateway returns an empty model list", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { data: [] }),
		);
		await expect(fetchModels("sk-x")).rejects.toThrow(
			"Gateway returned no models",
		);
	});

	test("throws when data is missing entirely", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));
		await expect(fetchModels("sk-x")).rejects.toThrow(
			"Gateway returned no models",
		);
	});

	test("filters out entries without an id string", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				data: [
					{ id: "good" },
					{ id: "" },
					{ id: null },
					{},
					{ id: "also-good" },
				],
			}),
		);
		await expect(fetchModels("sk-x")).resolves.toEqual(["good", "also-good"]);
	});

	test("uses a manual baseUrl that already has /v1", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
		await fetchModels("sk-y", "https://my-gw.example.com/v1");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://my-gw.example.com/v1/models");
	});

	test("appends /v1 when the baseUrl lacks it", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, { data: [{ id: "m1" }] }));
		await fetchModels("sk-z", "https://gw.example.com/");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe("https://gw.example.com/v1/models");
	});
});

describe("smokeTestModel", () => {
	test("returns null when the gateway accepts the completion", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { choices: [{ message: { content: "ok" } }] }),
		);
		await expect(
			smokeTestModel("sk-ok", "MiniMax/MiniMax-M2.7"),
		).resolves.toBeNull();
	});

	test("returns a reason with the status and body on a non-2xx", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("key not allowed to access model MiniMax/MiniMax-M2.7", {
				status: 403,
			}),
		);
		const reason = await smokeTestModel("sk-bad", "MiniMax/MiniMax-M2.7");
		expect(reason).toContain("MiniMax/MiniMax-M2.7");
		expect(reason).toContain("403");
		// The gateway's own message — the bit that distinguishes model-access
		// from over-budget from an edge block — is preserved.
		expect(reason).toContain("key not allowed to access model");
	});

	test("returns a reason instead of throwing on a network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
		const reason = await smokeTestModel("sk-x", "m1");
		expect(reason).toContain("ECONNREFUSED");
	});

	test("POSTs a 1-token completion to /v1/chat/completions for the model", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse(200, {}));
		await smokeTestModel("sk-y", "m-test", "https://gw.example.com/v1");
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://gw.example.com/v1/chat/completions");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body as string) as {
			model: string;
			max_tokens: number;
		};
		expect(body.model).toBe("m-test");
		expect(body.max_tokens).toBe(1);
	});
});

describe("fetchSupabaseSession", () => {
	test("posts to the backend /supabase/exchange endpoint", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				access_token: "supabase-token",
				user: { id: "uid", email: "x@y.z" },
			}),
		);
		await fetchSupabaseSession("sso-token");
		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toBe(`${BACKEND_URL}/supabase/exchange`);
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
			"Backend /supabase/exchange failed (401): invalid sso token",
		);
	});
});

describe("fetchCodevConfig", () => {
	test("returns the Supabase coordinates and gateway URL on a 2xx response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				supabaseUrl: "https://x.supabase.co",
				supabaseAnonKey: "anon",
				gatewayUrl: "https://gw.example.com/gateway",
			}),
		);
		expect(await fetchCodevConfig("sso-token")).toEqual({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon",
			gatewayUrl: "https://gw.example.com/gateway",
		});
	});

	test("posts to the backend /config endpoint with a Bearer token", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				supabaseUrl: "u",
				supabaseAnonKey: "a",
				gatewayUrl: "g",
			}),
		);
		await fetchCodevConfig("my-token");
		const [url, init] = fetchSpy.mock.calls[0] as [
			string,
			{ method?: string; headers?: Record<string, string> },
		];
		expect(url).toBe(`${BACKEND_URL}/config`);
		expect(init.method).toBe("POST");
		expect(init.headers?.Authorization).toBe("Bearer my-token");
	});

	test("throws on a non-2xx response with the backend-supplied error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, { error: "invalid sso" }),
		);
		await expect(fetchCodevConfig("bad")).rejects.toThrow(
			"Backend /config failed (401): invalid sso",
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

	test("throws when only the gatewayUrl is missing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, { supabaseUrl: "u", supabaseAnonKey: "a" }),
		);
		await expect(fetchCodevConfig("token")).rejects.toThrow(
			/incomplete payload/,
		);
	});
});

describe("isInvalidKeyError", () => {
	test("returns true for fetchModels 401 errors", () => {
		expect(
			isInvalidKeyError(new Error("Models fetch failed (401): invalid key")),
		).toBe(true);
	});

	test("returns true for fetchModels 403 errors", () => {
		expect(
			isInvalidKeyError(new Error("Models fetch failed (403): forbidden")),
		).toBe(true);
	});

	test("returns false for 5xx errors", () => {
		expect(
			isInvalidKeyError(new Error("Models fetch failed (500): Server Error")),
		).toBe(false);
	});

	test("returns false for network errors", () => {
		expect(isInvalidKeyError(new Error("fetch failed"))).toBe(false);
	});

	test("returns false for non-Error values", () => {
		expect(isInvalidKeyError("oops")).toBe(false);
		expect(isInvalidKeyError(null)).toBe(false);
		expect(isInvalidKeyError(undefined)).toBe(false);
	});
});
