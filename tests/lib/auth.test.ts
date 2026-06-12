import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type AuthData,
	browserOpener,
	loadApiKey,
	loadAuth,
	login,
	logout,
	refreshCodevConfig,
	saveApiKey,
	saveCodevConfig,
	saveProxyUrl,
} from "@/lib/auth.js";
import { LOGIN_SUCCESS_URL, SSO_URL } from "@/lib/const.js";

const REVOCATION_ENDPOINT = `${SSO_URL}/revoke`;

let tempDir: string;
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
	vi.stubEnv("HOME", tempDir);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
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
	return vi.spyOn(globalThis, "fetch").mockImplementation((async (
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
	let fetchSpy: MockInstance;

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
			}),
		);
		expect(await logout()).toBe(true);
		expect(loadAuth()).toBeNull();
		const after = JSON.parse(
			readFileSync(join(dir, "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(after.supabase_url).toBe("https://keep.supabase.co");
		expect(after.supabase_anon_key).toBe("keep-anon");
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
			}),
		);
		expect(await logout()).toBe(true);
		expect(loadApiKey()?.apiKey).toBe("sk-keep");
		const after = JSON.parse(
			readFileSync(join(dir, "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(after.supabase_url).toBe("https://keep.supabase.co");
	});

	test("preserves proxy_url when stripping SSO (override survives logout)", async () => {
		const dir = join(tempDir, ".codev");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				...VALID_AUTH,
				proxy_url: "https://keep-proxy.example.com",
			}),
		);
		expect(await logout()).toBe(true);
		const after = JSON.parse(
			readFileSync(join(dir, "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(after.proxy_url).toBe("https://keep-proxy.example.com");
		expect(after.access_token).toBeUndefined();
	});
});

describe("saveProxyUrl", () => {
	test("writes proxy_url into auth.json", () => {
		saveProxyUrl("https://my-proxy.example.com");
		const file = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(file.proxy_url).toBe("https://my-proxy.example.com");
	});

	test("empty string clears the override (proxy_url drops out of the file)", () => {
		saveProxyUrl("https://my-proxy.example.com");
		saveProxyUrl("");
		const file = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(file.proxy_url).toBeUndefined();
	});

	test("does not clobber SSO fields when saving the proxy URL", () => {
		writeAuthFile(VALID_AUTH);
		saveProxyUrl("https://my-proxy.example.com");
		expect(loadAuth()?.access_token).toBe("test-access-token");
	});

	test("does not clobber api_key when saving the proxy URL", () => {
		saveApiKey({ apiKey: "sk-keep", baseUrl: "https://gw/v1", model: "m" });
		saveProxyUrl("https://my-proxy.example.com");
		expect(loadApiKey()).toEqual({
			apiKey: "sk-keep",
			baseUrl: "https://gw/v1",
			model: "m",
		});
	});

	test("does not clobber supabase config when saving the proxy URL", () => {
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
		});
		saveProxyUrl("https://my-proxy.example.com");
		const file = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(file.supabase_url).toBe("https://x.supabase.co");
		expect(file.supabase_anon_key).toBe("anon-x");
		expect(file.proxy_url).toBe("https://my-proxy.example.com");
	});

	test("clearing the override preserves other fields", () => {
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
		});
		saveApiKey({ apiKey: "sk-keep" });
		saveProxyUrl("https://my-proxy.example.com");
		saveProxyUrl("");
		const file = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(file.supabase_url).toBe("https://x.supabase.co");
		expect(file.api_key).toBe("sk-keep");
		expect(file.proxy_url).toBeUndefined();
	});

	// Skipped on Windows: NTFS has no POSIX permission bits — see the matching
	// saveCodevConfig case above.
	test.skipIf(process.platform === "win32")(
		"file is written with mode 0600",
		() => {
			saveProxyUrl("https://my-proxy.example.com");
			const stat = statSync(join(tempDir, ".codev", "auth.json"));
			expect(stat.mode & 0o777).toBe(0o600);
		},
	);
});

describe("saveCodevConfig", () => {
	test("round-trips the Supabase fields through auth.json", () => {
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
		});
		const file = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(file.supabase_url).toBe("https://x.supabase.co");
		expect(file.supabase_anon_key).toBe("anon-x");
	});

	test("does not clobber SSO fields when saving codev config", () => {
		writeAuthFile(VALID_AUTH);
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
		});
		expect(loadAuth()?.access_token).toBe("test-access-token");
	});

	test("does not clobber api_key when saving codev config", () => {
		saveApiKey({ apiKey: "sk-merged" });
		saveCodevConfig({
			supabaseUrl: "https://x.supabase.co",
			supabaseAnonKey: "anon-x",
		});
		expect(loadApiKey()?.apiKey).toBe("sk-merged");
	});

	// Skipped on Windows: NTFS has no POSIX permission bits, so fs.chmod's 0o600
	// becomes 0o666 once read back. The auth file is still ACL-protected to the
	// user — the assertion is the POSIX-only piece.
	test.skipIf(process.platform === "win32")(
		"file is written with mode 0600",
		() => {
			saveCodevConfig({
				supabaseUrl: "u",
				supabaseAnonKey: "a",
			});
			const stat = statSync(join(tempDir, ".codev", "auth.json"));
			expect(stat.mode & 0o777).toBe(0o600);
		},
	);
});

describe("refreshCodevConfig", () => {
	test("fetches /config and writes Supabase coords into auth.json", async () => {
		const fetchSpy = mockAuthFetch({
			"/codev-proxy/config": async () =>
				new Response(
					JSON.stringify({
						supabaseUrl: "https://fresh.supabase.co",
						supabaseAnonKey: "fresh-anon",
					}),
					{ headers: { "Content-Type": "application/json" } },
				),
		});
		try {
			await refreshCodevConfig("token", () => {});
			const saved = JSON.parse(
				readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
			) as Record<string, unknown>;
			expect(saved.supabase_url).toBe("https://fresh.supabase.co");
			expect(saved.supabase_anon_key).toBe("fresh-anon");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("logs a warning and does not throw on failure", async () => {
		const fetchSpy = mockAuthFetch({
			"/codev-proxy/config": async () =>
				new Response(JSON.stringify({ error: "boom" }), { status: 502 }),
		});
		const logs: string[] = [];
		try {
			await refreshCodevConfig("token", (msg) => logs.push(msg));
			expect(
				logs.some((l) => l.includes("could not refresh CoDev config")),
			).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
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

	// Skipped on Windows: NTFS has no POSIX permission bits — see the matching
	// saveCodevConfig case above.
	test.skipIf(process.platform === "win32")(
		"file is written with mode 0600",
		() => {
			saveApiKey({ apiKey: "sk-perms" });
			const stat = statSync(join(tempDir, ".codev", "auth.json"));
			expect(stat.mode & 0o777).toBe(0o600);
		},
	);
});

describe("login CODEV_BYPASS_LOGIN", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("returns a stub session and never opens the browser when set", async () => {
		vi.stubEnv("CODEV_BYPASS_LOGIN", "1");
		const onReady = vi.fn();
		const logs: string[] = [];

		const result = await login((msg) => logs.push(msg), onReady);

		expect(result.access_token).toBe("codev-bypass-no-sso");
		expect(result.user.email).toBe("bypass@local");
		// Sentinel token must hit disk so subsequent commands see the session.
		expect(loadAuth()?.access_token).toBe("codev-bypass-no-sso");
		// No browser handshake, no /authorize redirect.
		expect(onReady).not.toHaveBeenCalled();
		expect(logs.some((l) => l.includes("CODEV_BYPASS_LOGIN=1"))).toBe(true);
	});

	test("does nothing special when the env var is unset or != '1'", async () => {
		vi.stubEnv("CODEV_BYPASS_LOGIN", "true");
		writeAuthFile(VALID_AUTH);

		const result = await login(
			() => {},
			() => {},
		);

		// Falls through to the normal "already logged in" path, NOT the stub.
		expect(result.access_token).toBe("test-access-token");
	});
});

describe("login", () => {
	test("returns existing auth when already logged in", async () => {
		writeAuthFile(VALID_AUTH);
		const logs: string[] = [];
		const onReady = vi.fn();

		// login() no longer refreshes CoDev config — every /codev-proxy/config
		// call would be a violation. Spy on fetch so any stray call is visible.
		const fetchSpy = mockAuthFetch({});

		try {
			const result = await login((msg) => logs.push(msg), onReady);

			expect(result.access_token).toBe("test-access-token");
			expect(result.user.email).toBe("test@example.com");
			expect(logs).toContain("Starting SSO login...");
			expect(logs.some((l) => l.includes("Already logged in"))).toBe(true);
			expect(onReady).not.toHaveBeenCalled();

			const configCalls = fetchSpy.mock.calls.filter((c: unknown[]) =>
				String(c[0]).includes("/codev-proxy/config"),
			);
			expect(configCalls).toHaveLength(0);
		} finally {
			fetchSpy.mockRestore();
		}
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
	let fetchSpy: MockInstance;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("refreshes tokens silently without touching codev-proxy", async () => {
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
		});

		const result = await login(
			() => {},
			() => {},
		);

		expect(result.access_token).toBe("refreshed-access");
		const configCalls = fetchSpy.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("/codev-proxy/config"),
		);
		expect(configCalls).toHaveLength(0);
	});
});

function getAuthorizeUrl(spy: MockInstance): URL | null {
	const call = spy.mock.calls[0];
	if (!call) return null;
	return new URL(call[0] as string);
}

// The CLI opens the local browser at the loopback authorize URL, whose
// redirect_uri is the 127.0.0.1 callback directly; pull its port back out.
function loopbackPort(redirectUriParam: string | null | undefined): number {
	if (!redirectUriParam) return 0;
	try {
		return Number.parseInt(new URL(redirectUriParam).port, 10) || 0;
	} catch {
		return 0;
	}
}

function getCallbackPort(spy: MockInstance): number {
	const authorizeUrl = getAuthorizeUrl(spy);
	return loopbackPort(authorizeUrl?.searchParams.get("redirect_uri"));
}

function getCallbackState(spy: MockInstance): string {
	return getAuthorizeUrl(spy)?.searchParams.get("state") ?? "";
}

function getCallbackNonce(spy: MockInstance): string {
	return getAuthorizeUrl(spy)?.searchParams.get("nonce") ?? "";
}

type RedirectResult = { status: number; location: string };

// GET a URL without following redirects so a test can assert the 302 + Location
// the loopback callback now returns. (fetch's redirect:"manual" yields an
// opaque response whose Location header isn't readable, so use node:http.)
function getNoRedirect(url: string): Promise<RedirectResult> {
	return new Promise((resolve, reject) => {
		httpGet(url, (res) => {
			res.resume();
			resolve({
				status: res.statusCode ?? 0,
				location: res.headers.location ?? "",
			});
		}).on("error", reject);
	});
}

describe("login full OAuth flow", () => {
	let fetchSpy: MockInstance;
	let openBrowserSpy: MockInstance;
	const originalFetch = globalThis.fetch;

	function mockSsoFetch() {
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
	}

	beforeEach(() => {
		openBrowserSpy = vi
			.spyOn(browserOpener, "open")
			.mockImplementation(() => Promise.resolve(undefined));
		// These tests exercise the silent /authorize → /callback path. Login
		// only takes that path when ~/.codev/auth.json exists (its absence
		// signals "fresh machine or post-remove — force re-auth via the
		// wrapper /logout flow").
		mkdirSync(join(tempDir, ".codev"), { recursive: true });
		writeFileSync(join(tempDir, ".codev", "auth.json"), "{}");
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

	test("opens the local browser at the loopback callback (no public page in the middle)", async () => {
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

		// The browser is sent straight to the loopback callback so the IdP
		// navigates it to 127.0.0.1 directly — no public page reaches into
		// localhost, so there's no "local network access" prompt.
		const opened = getAuthorizeUrl(openBrowserSpy);
		const redirectUri = new URL(opened?.searchParams.get("redirect_uri") ?? "");
		expect(redirectUri.hostname).toBe("127.0.0.1");
		expect(redirectUri.pathname).toBe("/callback");
		expect(Number.parseInt(redirectUri.port, 10)).toBeGreaterThan(0);
		// No nested redirect_uri — it's the plain loopback, not a wrapped page URL.
		expect(redirectUri.searchParams.get("redirect_uri")).toBeNull();
	});

	test("hands onReady the public success-page URL for manual paste-back", async () => {
		mockSsoFetch();
		let capturedUrl = "";

		const result = await login(
			() => {},
			(openBrowserFn, url) => {
				capturedUrl = url;
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
		// The manual URL points at the public success page (which displays the code
		// to copy), NOT the loopback the browser was opened with.
		const manual = new URL(capturedUrl);
		expect(manual.pathname).toBe("/sso-wrapper/authorize");
		const manualRedirect = manual.searchParams.get("redirect_uri") ?? "";
		expect(manualRedirect).toBe(LOGIN_SUCCESS_URL);
		const openedUrl = openBrowserSpy.mock.calls[0]?.[0] as string;
		expect(capturedUrl).not.toBe(openedUrl);
	});

	test("does not call codev-proxy /config during login", async () => {
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

		const configCalls = fetchSpy.mock.calls.filter((c: unknown[]) =>
			String(c[0]).includes("/codev-proxy/config"),
		);
		expect(configCalls).toHaveLength(0);
		const saved = JSON.parse(
			readFileSync(join(tempDir, ".codev", "auth.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(saved.supabase_url).toBeUndefined();
		expect(saved.access_token).toBe("flow-access-token");
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

		await expect(loginPromise).rejects.toThrow("SSO login failed: User denied");
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

		await expect(loginPromise).rejects.toThrow("State mismatch");
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

		await expect(loginPromise).rejects.toThrow(
			"No authorization code received",
		);
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

	test("redirects to the success page on a valid code", async () => {
		mockSsoFetch();
		let callbackResPromise: Promise<RedirectResult> | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				const state = getCallbackState(openBrowserSpy);
				callbackResPromise = new Promise((resolve) => {
					setTimeout(() => {
						resolve(
							getNoRedirect(
								`http://localhost:${port}/callback?code=c&state=${state}`,
							),
						);
					}, 50);
				});
			},
		);

		await loginPromise;
		expect(callbackResPromise).not.toBeNull();
		const callbackRes =
			await (callbackResPromise as unknown as Promise<RedirectResult>);
		expect(callbackRes.status).toBe(302);
		expect(callbackRes.location).toBe(LOGIN_SUCCESS_URL);
	});

	test("redirects to the success page's error view on error", async () => {
		mockSsoFetch();
		let callbackRes: RedirectResult | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				const port = getCallbackPort(openBrowserSpy);
				setTimeout(async () => {
					callbackRes = await getNoRedirect(
						`http://localhost:${port}/callback?error=denied`,
					);
				}, 50);
			},
		);

		await loginPromise.catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		expect(callbackRes).not.toBeNull();
		const res = callbackRes as unknown as RedirectResult;
		expect(res.status).toBe(302);
		expect(res.location).toContain(`${LOGIN_SUCCESS_URL}?error=login_failed`);
		expect(res.location).toContain("error_description=denied");
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
	let fetchSpy: MockInstance;
	let openBrowserSpy: MockInstance;
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
		openBrowserSpy = vi
			.spyOn(browserOpener, "open")
			.mockImplementation(() => Promise.resolve(undefined));
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

	test("uses /authorize directly when no marker is present and auth.json exists", async () => {
		// auth.json must exist for the silent path — otherwise the
		// fresh-machine check forces login. Seed an empty auth file, no marker.
		mkdirSync(join(tempDir, ".codev"), { recursive: true });
		writeFileSync(join(tempDir, ".codev", "auth.json"), "{}");

		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
				const port = loopbackPort(openedUrl.searchParams.get("redirect_uri"));
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

	test("forces login when auth.json is absent (e.g. after `codev remove`)", async () => {
		// No marker written, AND no auth.json created — mirrors the state left
		// behind by `codev remove`'s rmSync. The IdP's still-valid browser
		// session cookie must not be silently reused: the next login must
		// take the wrapper-logout path so the user retypes credentials.
		expect(existsSync(join(tempDir, ".codev", "auth.json"))).toBe(false);

		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
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
		expect((openedUrl as unknown as URL).pathname).toBe("/sso-wrapper/logout");
	});

	test("forces login even when ~/.codev exists without auth.json (diagnostics side effect)", async () => {
		// Diagnostic logging (lib/log.ts) and runExport both create dirs under
		// ~/.codev before login can run. Their side effects must not read as
		// "prior auth on this machine" — only auth.json itself counts.
		mkdirSync(join(tempDir, ".codev", "logs"), { recursive: true });

		let openedUrl: URL | null = null;

		const loginPromise = login(
			() => {},
			(openBrowserFn) => {
				openBrowserFn();
				openedUrl = getInitialUrl();
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
		expect((openedUrl as unknown as URL).pathname).toBe("/sso-wrapper/logout");
	});

	test("hands the manual paste-back channel the /authorize URL, not the loopback-only /logout bounce", async () => {
		// On force-login the browser is opened at /logout (to clear the IdP
		// cookie), but that bounce redirects to a loopback-only /logout-done page
		// a remote browser can't reach — so the no-browser channel must instead be
		// given the plain /authorize URL, which a remote browser CAN complete.
		writeMarker();
		let manualUrl = "";

		const result = await login(
			() => {},
			(_open, url, submit) => {
				manualUrl = url;
				// Reconstruct the success-page URL the remote user copies back, with
				// the same state the /authorize URL carries.
				const u = new URL(url);
				const state = u.searchParams.get("state") ?? "";
				expect(
					submit(`${LOGIN_SUCCESS_URL}?code=pasted&state=${state}`),
				).toBeNull();
			},
		);

		expect(new URL(manualUrl).pathname).toBe("/sso-wrapper/authorize");
		// No browser was opened — the remote user pasted the callback URL by hand.
		expect(openBrowserSpy).not.toHaveBeenCalled();
		expect(result.access_token).toBe("flow-access-token");
	});
});

describe("login manual paste-back (no-browser)", () => {
	let fetchSpy: MockInstance;
	let openBrowserSpy: MockInstance;

	beforeEach(() => {
		openBrowserSpy = vi
			.spyOn(browserOpener, "open")
			.mockImplementation(() => Promise.resolve(undefined));
		// Silent /authorize path requires ~/.codev/auth.json to exist (its
		// absence signals "fresh machine or post-remove — force re-auth via
		// the wrapper /logout flow").
		mkdirSync(join(tempDir, ".codev"), { recursive: true });
		writeFileSync(join(tempDir, ".codev", "auth.json"), "{}");
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

	// In the manual flow the IdP lands the remote browser on the public success
	// page, which shows the code. Reconstruct that page URL (same state) — what the
	// user copies back into the prompt.
	function callbackUrlFor(
		authUrl: string,
		code: string,
		stateOverride?: string,
	): string {
		const u = new URL(authUrl);
		const state = stateOverride ?? u.searchParams.get("state") ?? "";
		return `${LOGIN_SUCCESS_URL}?code=${code}&state=${state}`;
	}

	test("completes when the user pastes the success-page URL", async () => {
		const result = await login(
			() => {},
			(_open, url, submit) => {
				expect(submit(callbackUrlFor(url, "pasted-code"))).toBeNull();
			},
		);

		expect(result.access_token).toBe("flow-access-token");
		expect(result.user.email).toBe("flow@example.com");
		expect(existsSync(join(tempDir, ".codev", "auth.json"))).toBe(true);
		// No browser was opened — the remote user pasted the URL back by hand.
		expect(openBrowserSpy).not.toHaveBeenCalled();
	});

	test("accepts a bare authorization code (no state to cross-check)", async () => {
		const result = await login(
			() => {},
			(_open, _url, submit) => {
				expect(submit("bare-code-123")).toBeNull();
			},
		);
		expect(result.access_token).toBe("flow-access-token");
	});

	test("accepts a scheme-less success-page URL (host/?code=...)", async () => {
		const result = await login(
			() => {},
			(_open, url, submit) => {
				const state = new URL(url).searchParams.get("state") ?? "";
				const host = new URL(LOGIN_SUCCESS_URL).host;
				// No "https://" prefix — as some browsers show (and copy) it.
				expect(submit(`${host}/?code=schemeless&state=${state}`)).toBeNull();
			},
		);
		expect(result.access_token).toBe("flow-access-token");
	});

	test("rejects a state mismatch inline, then recovers on re-paste", async () => {
		const result = await login(
			() => {},
			(_open, url, submit) => {
				expect(submit(callbackUrlFor(url, "x", "wrong-state"))).toContain(
					"state mismatch",
				);
				// The flow is still live — a correct paste finishes it.
				expect(submit(callbackUrlFor(url, "good-code"))).toBeNull();
			},
		);
		expect(result.access_token).toBe("flow-access-token");
	});

	test("surfaces an SSO error param inline, then recovers", async () => {
		const result = await login(
			() => {},
			(_open, url, submit) => {
				expect(
					submit(
						`${LOGIN_SUCCESS_URL}?error=access_denied&error_description=denied`,
					),
				).toContain("denied");
				expect(submit(callbackUrlFor(url, "good-code"))).toBeNull();
			},
		);
		expect(result.access_token).toBe("flow-access-token");
	});

	test("reports an empty paste without settling the flow", async () => {
		const result = await login(
			() => {},
			(_open, url, submit) => {
				expect(submit("   ")).toContain("Paste the callback URL");
				expect(submit(callbackUrlFor(url, "good-code"))).toBeNull();
			},
		);
		expect(result.access_token).toBe("flow-access-token");
	});
});
