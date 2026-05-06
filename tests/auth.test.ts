import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthData,
	browserOpener,
	loadApiKey,
	loadAuth,
	login,
	logout,
	saveApiKey,
	saveCodevConfig,
} from "@/auth.js";
import { BASE_URL } from "@/const.js";

const SSO_BASE_URL = `${BASE_URL}sso-wrapper`;
const REVOCATION_ENDPOINT = `${SSO_BASE_URL}/revoke`;

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
});

afterEach(() => {
	homedirSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeAuthFile(data: AuthData) {
	const dir = join(tempDir, ".codev");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(data, null, 2));
}

function mockAuthFetch(
	handlers: Partial<Record<string, (url: string) => Promise<Response>>> = {},
) {
	const originalFetch = globalThis.fetch;
	return spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
	) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		for (const [key, handler] of Object.entries(handlers)) {
			if (handler && url.includes(key)) return handler(url);
		}
		return originalFetch(input);
	}) as typeof fetch);
}

describe("loadAuth", () => {
	test("returns auth data when file exists and is not expired", () => {
		writeAuthFile(VALID_AUTH);
		const result = loadAuth();
		expect(result).not.toBeNull();
		expect(result?.access_token).toBe("test-access-token");
		expect(result?.user.email).toBe("test@example.com");
	});

	test("returns null when file does not exist", () => {
		const result = loadAuth();
		expect(result).toBeNull();
	});

	test("returns null when token is expired", () => {
		writeAuthFile(EXPIRED_AUTH);
		const result = loadAuth();
		expect(result).toBeNull();
	});

	test("returns null when file contains invalid JSON", () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), "not valid json{{{");
		const result = loadAuth();
		expect(result).toBeNull();
	});
});

describe("logout", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = mockAuthFetch({
			[REVOCATION_ENDPOINT]: async () => new Response("", { status: 200 }),
		});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	test("removes the auth file", async () => {
		writeAuthFile(VALID_AUTH);
		expect(loadAuth()).not.toBeNull();
		expect(await logout()).toBe(true);
		expect(loadAuth()).toBeNull();
	});

	test("returns false when no auth file exists", async () => {
		expect(await logout()).toBe(false);
	});

	test("posts to revocation endpoint for access_token and refresh_token", async () => {
		writeAuthFile({ ...VALID_AUTH, refresh_token: "test-refresh" });
		await logout();

		const revokeCalls = fetchSpy.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("/revoke"),
		);
		expect(revokeCalls.length).toBe(2);

		const bodies = revokeCalls.map(
			(c: unknown[]) =>
				(c[1] as RequestInit | undefined)?.body?.toString() ?? "",
		);
		expect(
			bodies.some((b: string) => b.includes("token_type_hint=access_token")),
		).toBe(true);
		expect(
			bodies.some((b: string) => b.includes("token_type_hint=refresh_token")),
		).toBe(true);
	});

	test("writes force-login marker so next login re-auths at the IdP", async () => {
		writeAuthFile(VALID_AUTH);
		await logout();
		expect(existsSync(join(tempDir, ".codev", "force-login"))).toBe(true);
	});

	test("does not write marker when there was no auth file to remove", async () => {
		expect(await logout()).toBe(false);
		expect(existsSync(join(tempDir, ".codev", "force-login"))).toBe(false);
	});

	test("preserves api_key when stripping SSO fields", async () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				...VALID_AUTH,
				refresh_token: "test-refresh",
				api_key: "sk-keep-me",
				base_url: "https://gw.example.com/v1",
				model: "m1",
			}),
		);
		expect(await logout()).toBe(true);
		expect(loadAuth()).toBeNull();
		expect(loadApiKey()).toEqual({
			apiKey: "sk-keep-me",
			baseUrl: "https://gw.example.com/v1",
			model: "m1",
		});
	});

	test("returns false when only api_key is present (already logged out)", async () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ api_key: "sk-orphan" }),
		);
		expect(await logout()).toBe(false);
	});

	test("preserves supabase config when stripping SSO fields", async () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				...VALID_AUTH,
				supabase_url: "https://keep.supabase.co",
				supabase_anon_key: "keep-anon",
				supabase_proxy_url: "https://api.test/api/codev",
			}),
		);
		expect(await logout()).toBe(true);
		expect(loadAuth()).toBeNull();
		const after = JSON.parse(
			readFileSync(join(dir, "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(after.supabase_url).toBe("https://keep.supabase.co");
		expect(after.supabase_anon_key).toBe("keep-anon");
		expect(after.supabase_proxy_url).toBe("https://api.test/api/codev");
		expect(after.access_token).toBeUndefined();
		expect(after.refresh_token).toBeUndefined();
	});

	test("preserves both api_key and supabase config when stripping SSO", async () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				...VALID_AUTH,
				api_key: "sk-keep",
				supabase_url: "https://keep.supabase.co",
				supabase_anon_key: "keep-anon",
				supabase_proxy_url: "https://api.test/api/codev",
			}),
		);
		expect(await logout()).toBe(true);
		expect(loadApiKey()?.apiKey).toBe("sk-keep");
		const after = JSON.parse(
			readFileSync(join(dir, "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(after.supabase_url).toBe("https://keep.supabase.co");
	});
});

describe("saveCodevConfig", () => {
	test("round-trips the three Supabase fields through auth.json", () => {
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
			supabaseProxyUrl: "https://api.test/api/codev",
		});
		const file = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(file.supabase_url).toBe("https://x.supabase.co");
		expect(file.supabase_anon_key).toBe("anon-x");
		expect(file.supabase_proxy_url).toBe("https://api.test/api/codev");
	});

	test("does not clobber SSO fields when saving codev config", () => {
		writeAuthFile(VALID_AUTH);
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
			supabaseProxyUrl: "https://api.test/api/codev",
		});
		expect(loadAuth()?.access_token).toBe("test-access-token");
	});

	test("does not clobber api_key when saving codev config", () => {
		saveApiKey({ apiKey: "sk-merged" });
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
			supabaseProxyUrl: "https://api.test/api/codev",
		});
		expect(loadApiKey()?.apiKey).toBe("sk-merged");
	});

	test("file is written with mode 0600", () => {
		saveCodevConfig({
			supabaseUrl: "u",
			supabaseAnonKey: "a",
			supabaseProxyUrl: "p",
		});
		const stat = statSync(join(tempDir, ".codev", "auth.json"));
		expect(stat.mode & 0o777).toBe(0o600);
	});
});

describe("saveApiKey / loadApiKey", () => {
	test("round-trips api_key with optional baseUrl and model", () => {
		saveApiKey({
			apiKey: "sk-1",
			baseUrl: "https://x.example.com/v1",
			model: "m",
		});
		expect(loadApiKey()).toEqual({
			apiKey: "sk-1",
			baseUrl: "https://x.example.com/v1",
			model: "m",
		});
	});

	test("returns null when no auth file exists", () => {
		expect(loadApiKey()).toBeNull();
	});

	test("returns null when auth file has no api_key", () => {
		writeAuthFile(VALID_AUTH);
		expect(loadApiKey()).toBeNull();
	});

	test("does not clobber SSO fields when saving an api_key", () => {
		writeAuthFile(VALID_AUTH);
		saveApiKey({ apiKey: "sk-merged" });
		const result = loadAuth();
		expect(result?.access_token).toBe("test-access-token");
		expect(loadApiKey()).toEqual({
			apiKey: "sk-merged",
			baseUrl: undefined,
			model: undefined,
		});
	});

	test("file is written with mode 0600", () => {
		saveApiKey({ apiKey: "sk-perms" });
		const stat = statSync(join(tempDir, ".codev", "auth.json"));
		expect(stat.mode & 0o777).toBe(0o600);
	});
});

describe("login", () => {
	test("returns existing auth when already logged in", async () => {
		writeAuthFile(VALID_AUTH);
		const logs: string[] = [];
		const onReady = mock();

		const result = await login((msg) => logs.push(msg), onReady);

		expect(result.access_token).toBe("test-access-token");
		expect(result.user.email).toBe("test@example.com");
		expect(logs).toContain("Starting SSO login...");
		expect(logs.some((l) => l.includes("Already logged in"))).toBe(true);
		expect(onReady).not.toHaveBeenCalled();
	});

	test("calls onReady when no existing auth", async () => {
		const logs: string[] = [];
		let readyCalled = false;

		const loginPromise = login(
			(msg) => logs.push(msg),
			() => {
				readyCalled = true;
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(readyCalled).toBe(true);
		expect(logs).toContain("Starting SSO login...");

		loginPromise.catch(() => {});
	});
});

describe("login refresh-token path", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("refreshes tokens and persists Supabase config from /config", async () => {
		// Pre-seed an expired SSO session with a refresh_token so login() takes
		// the silent-refresh branch instead of the browser flow.
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				access_token: "stale",
				id_token: "stale",
				refresh_token: "rt-keep",
				expires_at: Date.now() - 1000,
				user: { sub: "u", email: "u@example.com", displayName: "U" },
			}),
		);

		fetchSpy = mockAuthFetch({
			"/token": async () =>
				new Response(
					JSON.stringify({
						access_token: "refreshed-access",
						id_token: "refreshed-id",
						expires_in: 3600,
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			"/userinfo": async () =>
				new Response(
					JSON.stringify({
						sub: "u",
						email: "u@example.com",
						displayName: "U",
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			"/codev-proxy/config": async () =>
				new Response(
					JSON.stringify({
						supabaseUrl: "https://refreshed.supabase.co",
						supabaseAnonKey: "refreshed-anon",
						supabaseProxyUrl: "https://api.test/api/codev",
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		});

		const result = await login(
			() => {},
			() => {},
		);

		expect(result.access_token).toBe("refreshed-access");
		const saved = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(saved.supabase_url).toBe("https://refreshed.supabase.co");
		expect(saved.supabase_anon_key).toBe("refreshed-anon");
		expect(saved.supabase_proxy_url).toBe("https://api.test/api/codev");
	});
});

function getAuthorizeUrl(spy: ReturnType<typeof spyOn>): URL | null {
	const call = spy.mock.calls[0];
	if (!call) return null;
	return new URL(call[0] as string);
}

function getCallbackPort(spy: ReturnType<typeof spyOn>): number {
	const authorizeUrl = getAuthorizeUrl(spy);
	const redirectUri = authorizeUrl?.searchParams.get("redirect_uri");
	if (!redirectUri) return 0;
	return Number.parseInt(new URL(redirectUri).port, 10);
}

function getCallbackState(spy: ReturnType<typeof spyOn>): string {
	return getAuthorizeUrl(spy)?.searchParams.get("state") ?? "";
}

function getCallbackNonce(spy: ReturnType<typeof spyOn>): string {
	return getAuthorizeUrl(spy)?.searchParams.get("nonce") ?? "";
}

describe("login full OAuth flow", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let openBrowserSpy: ReturnType<typeof spyOn>;
	const originalFetch = globalThis.fetch;

	function mockSsoFetch(overrides: { config?: () => Promise<Response> } = {}) {
		fetchSpy = mockAuthFetch({
			"/token": async () =>
				new Response(
					JSON.stringify({
						access_token: "flow-access-token",
						id_token: "flow-id-token",
						expires_in: 3600,
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			"/userinfo": async () =>
				new Response(
					JSON.stringify({
						sub: "flowuser",
						email: "flow@example.com",
						displayName: "Flow User",
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			"/codev-proxy/config":
				overrides.config ??
				(async () =>
					new Response(
						JSON.stringify({
							supabaseUrl: "https://x.supabase.co",
							supabaseAnonKey: "anon-x",
							supabaseProxyUrl: "https://api.test/api/codev",
						}),
						{ headers: { "Content-Type": "application/json" } },
					)),
		});
	}

	beforeEach(() => {
		openBrowserSpy = spyOn(browserOpener, "open").mockImplementation(() =>
			Promise.resolve(undefined),
		);
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		openBrowserSpy?.mockRestore();
	});

	test("exchanges code, saves auth to disk", async () => {
		mockSsoFetch();
		const logs: string[] = [];

		const result = await login(
			(msg) => logs.push(msg),
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				const state = getCallbackState(openBrowserSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=test-auth-code&state=${state}`,
					);
				}, 50);
			},
		);

		expect(result.access_token).toBe("flow-access-token");
		expect(result.user.email).toBe("flow@example.com");
		expect(result.user.displayName).toBe("Flow User");

		const authFile = join(tempDir, ".codev", "auth.json");
		expect(existsSync(authFile)).toBe(true);
		const saved: AuthData = JSON.parse(readFileSync(authFile, "utf-8"));
		expect(saved.access_token).toBe("flow-access-token");

		expect(logs.some((l) => l.includes("Logged in as"))).toBe(true);
	});

	test("persists Supabase config from /config into auth.json", async () => {
		mockSsoFetch();

		await login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				const state = getCallbackState(openBrowserSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		const saved = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(saved.supabase_url).toBe("https://x.supabase.co");
		expect(saved.supabase_anon_key).toBe("anon-x");
		expect(saved.supabase_proxy_url).toBe("https://api.test/api/codev");
		expect(saved.access_token).toBe("flow-access-token");
	});

	test("login still succeeds when /config fetch fails (warns via onLog)", async () => {
		mockSsoFetch({
			config: async () =>
				new Response(JSON.stringify({ error: "boom" }), { status: 502 }),
		});
		const logs: string[] = [];

		const result = await login(
			(msg) => logs.push(msg),
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				const state = getCallbackState(openBrowserSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		expect(result.access_token).toBe("flow-access-token");
		const saved = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(saved.supabase_url).toBeUndefined();
		expect(logs.some((l) => l.includes("could not refresh CoDev config"))).toBe(
			true,
		);
	});

	test("authorize URL includes nonce", async () => {
		mockSsoFetch();

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				const state = getCallbackState(openBrowserSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;

		const nonce = getCallbackNonce(openBrowserSpy);
		expect(nonce).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	test("rejects when callback receives an error", async () => {
		mockSsoFetch();
		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?error=access_denied&error_description=User+denied`,
					);
				}, 50);
			},
		);

		expect(loginPromise).rejects.toThrow("SSO login failed: User denied");
	});

	test("rejects when callback state does not match", async () => {
		mockSsoFetch();
		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=abc&state=wrong-state`,
					);
				}, 50);
			},
		);

		expect(loginPromise).rejects.toThrow("State mismatch");
	});

	test("rejects when callback receives no code", async () => {
		mockSsoFetch();
		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				setTimeout(() => {
					originalFetch(`http://localhost:${port}/callback`);
				}, 50);
			},
		);

		expect(loginPromise).rejects.toThrow("No authorization code received");
	});

	test("callback server returns 404 for non-callback paths", async () => {
		mockSsoFetch();
		let callbackPort = 0;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				callbackPort = getCallbackPort(openBrowserSpy);
			},
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(callbackPort).toBeGreaterThan(0);
		const res = await originalFetch(`http://localhost:${callbackPort}/other`);
		expect(res.status).toBe(404);

		loginPromise.catch(() => {});
	});

	test("callback server returns success HTML on valid code", async () => {
		mockSsoFetch();
		let callbackResPromise: Promise<Response> | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				const state = getCallbackState(openBrowserSpy);
				callbackResPromise = new Promise((resolve) => {
					setTimeout(async () => {
						const res = await originalFetch(
							`http://localhost:${port}/callback?code=c&state=${state}`,
						);
						resolve(res);
					}, 50);
				});
			},
		);

		await loginPromise;
		expect(callbackResPromise).not.toBeNull();
		const callbackRes =
			await (callbackResPromise as unknown as Promise<Response>);
		const html = await callbackRes.text();
		expect(html).toContain("Login Successful");
	});

	test("callback server returns error HTML on error", async () => {
		mockSsoFetch();
		let callbackRes: Response | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				setTimeout(async () => {
					callbackRes = await originalFetch(
						`http://localhost:${port}/callback?error=denied`,
					);
				}, 50);
			},
		);

		await loginPromise.catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		expect(callbackRes).not.toBeNull();
		const html = await (callbackRes as unknown as Response).text();
		expect(html).toContain("Login Failed");
	});

	test("regression: stray request alongside /callback does not throw inside the handler", async () => {
		// Before the port-capture fix, the request handler called
		// `server.address()` on every request. When /callback closes the
		// server, any concurrent or stray request landed on the handler with
		// `server.address()` returning null and crashed with
		// "Cannot destructure property 'port' of 'server.address(...)'".
		// The fix captures the port once at listen-time so the handler never
		// re-reads the address. We assert here that firing /callback together
		// with a non-callback request lets the login resolve cleanly and that
		// no uncaught error surfaces in the test process.
		mockSsoFetch();
		const uncaught: Error[] = [];
		const onUncaught = (err: Error) => uncaught.push(err);
		process.on("uncaughtException", onUncaught);

		try {
			const result = await login(
				() => {},
				(openBrowserFn) => {
					openBrowserFn();
					const port = getCallbackPort(openBrowserSpy);
					const state = getCallbackState(openBrowserSpy);
					setTimeout(async () => {
						await Promise.all([
							originalFetch(
								`http://localhost:${port}/callback?code=c&state=${state}`,
							),
							originalFetch(`http://localhost:${port}/anything`).catch(
								() => null,
							),
						]);
					}, 50);
				},
			);
			expect(result.access_token).toBe("flow-access-token");
			// Give the loop a tick so any pending request handler errors surface.
			await new Promise((r) => setTimeout(r, 50));
		} finally {
			process.off("uncaughtException", onUncaught);
		}

		const portMessages = uncaught.filter((e) =>
			e.message.includes("server.address"),
		);
		expect(portMessages).toHaveLength(0);
	});

	test("regression: a follow-up request after the server closes does not crash the handler", async () => {
		// Same root cause as above, exercised via a sequential follow-up: the
		// browser may keep the loopback socket alive and send another request
		// (e.g. a favicon poke) after /callback already triggered server.close().
		mockSsoFetch();
		const uncaught: Error[] = [];
		const onUncaught = (err: Error) => uncaught.push(err);
		process.on("uncaughtException", onUncaught);
		let port = 0;

		try {
			const result = await login(
				() => {},
				(openBrowserFn) => {
					openBrowserFn();
					port = getCallbackPort(openBrowserSpy);
					const state = getCallbackState(openBrowserSpy);
					setTimeout(() => {
						originalFetch(
							`http://localhost:${port}/callback?code=c&state=${state}`,
						);
					}, 50);
				},
			);
			expect(result.access_token).toBe("flow-access-token");
			// Now the server has been closed. A follow-up request must not
			// throw inside the handler — either it responds (handler still
			// draining a socket) or the connection refuses; both are fine.
			await originalFetch(`http://localhost:${port}/follow-up`).catch(
				() => null,
			);
			await new Promise((r) => setTimeout(r, 50));
		} finally {
			process.off("uncaughtException", onUncaught);
		}

		const portMessages = uncaught.filter((e) =>
			e.message.includes("server.address"),
		);
		expect(portMessages).toHaveLength(0);
	});
});

describe("login with force-login marker", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let openBrowserSpy: ReturnType<typeof spyOn>;
	const originalFetch = globalThis.fetch;

	function writeMarker() {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "force-login"), "");
	}

	function getInitialUrl(): URL {
		const call = openBrowserSpy.mock.calls[0];
		return new URL(call?.[0] as string);
	}

	beforeEach(() => {
		openBrowserSpy = spyOn(browserOpener, "open").mockImplementation(() =>
			Promise.resolve(undefined),
		);
		fetchSpy = mockAuthFetch({
			"/token": async () =>
				new Response(
					JSON.stringify({
						access_token: "flow-access-token",
						id_token: "flow-id-token",
						expires_in: 3600,
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
			"/userinfo": async () =>
				new Response(
					JSON.stringify({
						sub: "flowuser",
						email: "flow@example.com",
						displayName: "Flow User",
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		});
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		openBrowserSpy?.mockRestore();
	});

	test("opens the wrapper /logout URL first instead of /authorize", async () => {
		writeMarker();
		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
				// Drive the chain: /logout-done → follow 302 → /callback
				const logoutDoneUri = openedUrl.searchParams.get("redirect_uri");
				const port = Number.parseInt(new URL(logoutDoneUri ?? "").port, 10);
				setTimeout(async () => {
					const redirect = await originalFetch(
						`http://localhost:${port}/logout-done`,
						{ redirect: "manual" },
					);
					const next = new URL(redirect.headers.get("location") ?? "");
					const state = next.searchParams.get("state") ?? "";
					await originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;
		expect(openedUrl).not.toBeNull();
		expect((openedUrl as unknown as URL).pathname).toBe("/sso-wrapper/logout");
		expect(
			(openedUrl as unknown as URL).searchParams.get("redirect_uri") ?? "",
		).toContain("/logout-done");
	});

	test("/logout-done returns a 302 to /authorize with the original PKCE params", async () => {
		writeMarker();
		let redirectLocation: string | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const initial = getInitialUrl();
				const logoutDoneUri = initial.searchParams.get("redirect_uri");
				const port = Number.parseInt(new URL(logoutDoneUri ?? "").port, 10);
				setTimeout(async () => {
					const redirect = await originalFetch(
						`http://localhost:${port}/logout-done`,
						{ redirect: "manual" },
					);
					redirectLocation = redirect.headers.get("location");
					const next = new URL(redirectLocation ?? "");
					const state = next.searchParams.get("state") ?? "";
					await originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;
		expect(redirectLocation).not.toBeNull();
		const authorizeUrl = new URL(redirectLocation as unknown as string);
		expect(authorizeUrl.pathname).toBe("/sso-wrapper/authorize");
		expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
		expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorizeUrl.searchParams.get("code_challenge") ?? "").not.toBe("");
		expect(authorizeUrl.searchParams.get("nonce") ?? "").toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	test("clears the force-login marker after a successful login", async () => {
		writeMarker();
		const markerPath = join(tempDir, ".codev", "force-login");
		expect(existsSync(markerPath)).toBe(true);

		await login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const initial = getInitialUrl();
				const logoutDoneUri = initial.searchParams.get("redirect_uri");
				const port = Number.parseInt(new URL(logoutDoneUri ?? "").port, 10);
				setTimeout(async () => {
					const redirect = await originalFetch(
						`http://localhost:${port}/logout-done`,
						{ redirect: "manual" },
					);
					const next = new URL(redirect.headers.get("location") ?? "");
					const state = next.searchParams.get("state") ?? "";
					await originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		expect(existsSync(markerPath)).toBe(false);
	});

	test("uses /authorize directly when no marker is present", async () => {
		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
				const port = Number.parseInt(
					openedUrl.searchParams.get("redirect_uri")
						? new URL(openedUrl.searchParams.get("redirect_uri") as string).port
						: "0",
					10,
				);
				const state = openedUrl.searchParams.get("state") ?? "";
				setTimeout(() => {
					originalFetch(
						`http://localhost:${port}/callback?code=c&state=${state}`,
					);
				}, 50);
			},
		);

		await loginPromise;
		expect((openedUrl as unknown as URL).pathname).toBe(
			"/sso-wrapper/authorize",
		);
	});
});
