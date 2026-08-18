import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKEND_URL } from "@/lib/const.js";
import {
	applyEnvProxy,
	backendHost,
	envVarKeys,
	hasProxyConfigured,
	httpApi,
	maskProxyCredentials,
	matchingNoProxyEntry,
	noProxyEntryMatches,
	overrideEnvVar,
	PROXY_APPLIED_ENV,
	proxyAutoEnabled,
	proxyEnvSummary,
	proxyForUrl,
	readProxyEnv,
	resetProxyState,
	stripNoProxyFor,
} from "@/lib/proxy.js";
import { spawner } from "@/lib/reexec.js";

// Every proxy variable Node or we might read. Cleared before each test so a
// developer's own shell can't leak into the assertions.
const PROXY_VARS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
	"NODE_USE_SYSTEM_CA",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	PROXY_APPLIED_ENV,
];

beforeEach(() => {
	for (const name of PROXY_VARS) vi.stubEnv(name, "");
	resetProxyState();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("readProxyEnv", () => {
	test("reads both upper and lower case spellings", () => {
		vi.stubEnv("http_proxy", "http://lower:1");
		vi.stubEnv("HTTPS_PROXY", "http://upper:2");
		const env = readProxyEnv();
		expect(env.httpProxy).toBe("http://lower:1");
		expect(env.httpsProxy).toBe("http://upper:2");
		expect(hasProxyConfigured(env)).toBe(true);
	});

	test("treats an empty string as unset", () => {
		vi.stubEnv("HTTP_PROXY", "   ");
		expect(hasProxyConfigured(readProxyEnv())).toBe(false);
	});

	test("NODE_USE_ENV_PROXY=0 counts as off", () => {
		vi.stubEnv("NODE_USE_ENV_PROXY", "0");
		expect(readProxyEnv().useEnvProxy).toBe(false);
	});

	test("reports NODE_TLS_REJECT_UNAUTHORIZED verbatim so 0 can be flagged", () => {
		vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
		expect(readProxyEnv().tlsRejectUnauthorized).toBe("0");
	});
});

describe("NO_PROXY matching", () => {
	test.each([
		["*.viettel.vn", "netmind.viettel.vn", true],
		[".viettel.vn", "netmind.viettel.vn", true],
		["viettel.vn", "netmind.viettel.vn", true],
		["viettel.vn", "viettel.vn", true],
		["*", "anything.example.com", true],
		["netmind.viettel.vn:443", "netmind.viettel.vn", true],
		["other.vn", "netmind.viettel.vn", false],
		// A suffix that is not on a label boundary must not match.
		["ettel.vn", "netmind.viettel.vn", false],
		["", "netmind.viettel.vn", false],
	])("%s vs %s → %s", (entry, host, expected) => {
		expect(noProxyEntryMatches(entry, host)).toBe(expected);
	});

	// The documented cause of "Login failed" on internal machines: images ship
	// with *.viettel.vn in NO_PROXY, which routes our backend traffic direct.
	test("finds the entry that exempts the CoDev backend", () => {
		vi.stubEnv("NO_PROXY", "localhost,127.0.0.1,*.viettel.vn");
		expect(matchingNoProxyEntry(readProxyEnv(), backendHost())).toBe(
			"*.viettel.vn",
		);
	});

	test("returns null when nothing exempts the backend", () => {
		vi.stubEnv("NO_PROXY", "localhost,127.0.0.1");
		expect(matchingNoProxyEntry(readProxyEnv(), backendHost())).toBeNull();
	});

	test("stripNoProxyFor removes only the offending entries", () => {
		expect(
			stripNoProxyFor("localhost, *.viettel.vn ,127.0.0.1", backendHost()),
		).toBe("localhost,127.0.0.1");
	});

	test("backendHost matches the configured backend URL", () => {
		expect(backendHost()).toBe(new URL(BACKEND_URL).hostname);
	});
});

describe("applyEnvProxy", () => {
	test("no-ops when no proxy is configured", () => {
		const spy = vi.spyOn(httpApi, "setGlobalProxyFromEnv");
		expect(applyEnvProxy().action).toBe("none");
		expect(spy).not.toHaveBeenCalled();
	});

	test("does nothing when the user already set NODE_USE_ENV_PROXY", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		const spy = vi.spyOn(httpApi, "setGlobalProxyFromEnv");
		expect(applyEnvProxy().action).toBe("already-active");
		expect(spy).not.toHaveBeenCalled();
	});

	test("enables the proxy in-process when Node supports it", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.spyOn(httpApi, "supported").mockReturnValue(true);
		const apply = vi
			.spyOn(httpApi, "setGlobalProxyFromEnv")
			.mockImplementation(() => {});
		const spawn = vi.spyOn(spawner, "spawnSync");

		expect(applyEnvProxy().action).toBe("applied");
		expect(apply).toHaveBeenCalledOnce();
		// The whole point of the fast path: no extra process.
		expect(spawn).not.toHaveBeenCalled();
		// The environment must reflect reality afterwards. Without this,
		// diagnoseError would report "Node is IGNORING your proxy settings" about
		// a request that had just gone through the proxy — and children we spawn
		// (npm, the agents) would not inherit it.
		expect(process.env.NODE_USE_ENV_PROXY).toBe("1");
		expect(readProxyEnv().useEnvProxy).toBe(true);
		expect(proxyAutoEnabled()).toBe(true);
	});

	test("a user-set NODE_USE_ENV_PROXY is not reported as auto-enabled", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		expect(applyEnvProxy().action).toBe("already-active");
		// The distinction drives the advice: only the auto path needs to tell the
		// user to set it in their shell for npm and the agents.
		expect(proxyAutoEnabled()).toBe(false);
	});

	test("falls back to a re-exec on a Node without setGlobalProxyFromEnv", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.spyOn(httpApi, "supported").mockReturnValue(false);
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const spawn = vi
			.spyOn(spawner, "spawnSync")
			// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
			.mockReturnValue({ status: 0 } as any);

		const result = applyEnvProxy();
		expect(result.action).toBe("reexec");
		expect(result.exitCode).toBe(0);

		// The child must carry the flag Node only reads at bootstrap, plus the
		// sentinel that stops it looping if Node still ignores it.
		const env = spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
		expect(env[PROXY_APPLIED_ENV]).toBe("1");
	});

	test("the sentinel stops a second attempt in the re-exec child", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.stubEnv(PROXY_APPLIED_ENV, "1");
		vi.spyOn(httpApi, "supported").mockReturnValue(false);
		const spawn = vi.spyOn(spawner, "spawnSync");

		expect(applyEnvProxy().action).toBe("already-active");
		expect(spawn).not.toHaveBeenCalled();
	});

	test("falls back to a re-exec when setGlobalProxyFromEnv throws", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.spyOn(httpApi, "supported").mockReturnValue(true);
		vi.spyOn(httpApi, "setGlobalProxyFromEnv").mockImplementation(() => {
			throw new Error("nope");
		});
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const spawn = vi
			.spyOn(spawner, "spawnSync")
			// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
			.mockReturnValue({ status: 3 } as any);

		const result = applyEnvProxy();
		expect(result.action).toBe("reexec");
		expect(result.exitCode).toBe(3);
		expect(spawn).toHaveBeenCalledOnce();
	});

	// The warning has to survive every branch: a NO_PROXY exemption defeats the
	// proxy no matter how (or whether) it was enabled.
	test("warns about a backend NO_PROXY exemption even with no proxy set", () => {
		vi.stubEnv("NO_PROXY", "*.viettel.vn");
		const result = applyEnvProxy();
		expect(result.action).toBe("none");
		expect(result.noProxyWarning).toContain("*.viettel.vn");
		expect(result.noProxyWarning).toContain("Login failed");
	});

	test("warns about a backend NO_PROXY exemption on the applied path", () => {
		vi.stubEnv("HTTPS_PROXY", "http://p:8080");
		vi.stubEnv("NO_PROXY", "*.viettel.vn");
		vi.spyOn(httpApi, "supported").mockReturnValue(true);
		vi.spyOn(httpApi, "setGlobalProxyFromEnv").mockImplementation(() => {});
		const result = applyEnvProxy();
		expect(result.action).toBe("applied");
		expect(result.noProxyWarning).toContain("*.viettel.vn");
	});
});

// Proxy URLs routinely carry credentials, and every place one is displayed —
// the check row, the per-request activity lines, the report file — is somewhere
// a user pastes into a ticket or a chat.
describe("credential masking", () => {
	test.each([
		["http://user:hunter2@10.0.0.1:8080", "http://user:***@10.0.0.1:8080"],
		["https://svc:p%40ss@proxy.corp:3128", "https://svc:***@proxy.corp:3128"],
		// Nothing to mask — left byte-identical.
		["http://10.0.0.1:8080", "http://10.0.0.1:8080"],
		["http://user@10.0.0.1:8080", "http://user@10.0.0.1:8080"],
	])("%s → %s", (input, expected) => {
		expect(maskProxyCredentials(input)).toBe(expected);
	});

	test("readProxyEnv keeps the real value — the retry child must authenticate", () => {
		vi.stubEnv("HTTPS_PROXY", "http://user:hunter2@10.0.0.1:8080");
		expect(readProxyEnv().httpsProxy).toBe("http://user:hunter2@10.0.0.1:8080");
	});
});

describe("proxyEnvSummary", () => {
	// "unset" is an answer: most failures this command exists for are a
	// *missing* variable, and a reader scanning for HTTP_PROXY should find it
	// stated rather than infer its absence.
	test("always lists the core variables, set or not", () => {
		// Explicit env, not process.env: the package manager exports
		// npm_config_registry for its own scripts, which would leak into an
		// assertion about the exact list.
		const summary = proxyEnvSummary({});
		expect(summary.map((v) => v.name)).toEqual([
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"NO_PROXY",
			"NODE_USE_ENV_PROXY",
			"NODE_USE_SYSTEM_CA",
			"NODE_EXTRA_CA_CERTS",
			"NODE_TLS_REJECT_UNAUTHORIZED",
		]);
		for (const v of summary) expect(v.value).toBeNull();
	});

	// Explicit env, not process.env: on Windows environment variables are
	// case-insensitive, so stubbing `http_proxy` there also answers to
	// `HTTP_PROXY` and the two spellings cannot be told apart.
	test("reports a set variable in the user's own spelling", () => {
		const summary = proxyEnvSummary({ http_proxy: "http://10.0.0.1:8080" });
		// The lowercase spelling is appended; the uppercase stays listed as unset
		// rather than silently absorbing the lowercase value.
		expect(summary.find((v) => v.name === "http_proxy")?.value).toBe(
			"http://10.0.0.1:8080",
		);
		expect(summary.find((v) => v.name === "HTTP_PROXY")?.value).toBeNull();
	});

	// readProxyEnv models a fixed set of fields; anything outside it was
	// invisible, including the remedy our own TLS guidance hands out.
	test("includes variables readProxyEnv does not model", () => {
		const names = proxyEnvSummary({
			NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
			npm_config_registry: "http://mirror.internal/npm",
			NODE_OPTIONS: "--max-old-space-size=4096",
		}).map((v) => v.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"NODE_EXTRA_CA_CERTS",
				"npm_config_registry",
				"NODE_OPTIONS",
			]),
		);
	});

	test("masks credentials in the reported values", () => {
		const value = proxyEnvSummary({
			HTTPS_PROXY: "http://user:hunter2@10.0.0.1:8080",
		}).find((v) => v.name === "HTTPS_PROXY")?.value;
		expect(value).toBe("http://user:***@10.0.0.1:8080");
	});

	test("an empty variable is reported as unset, not as a blank value", () => {
		expect(
			proxyEnvSummary({ HTTP_PROXY: "   " }).find(
				(v) => v.name === "HTTP_PROXY",
			)?.value,
		).toBeNull();
	});
});

describe("proxyForUrl", () => {
	test("returns null when Node was never told to use the proxy", () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		// NODE_USE_ENV_PROXY unset — the proxy is configured but ignored, so no
		// request actually went through it and claiming otherwise would mislead.
		expect(proxyForUrl("https://api.example.com/x")).toBeNull();
	});

	test("picks the proxy matching the URL's scheme", () => {
		vi.stubEnv("HTTP_PROXY", "http://plain:80");
		vi.stubEnv("HTTPS_PROXY", "http://secure:443");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		expect(proxyForUrl("https://api.example.com/x")).toBe("http://secure:443");
		expect(proxyForUrl("http://api.example.com/x")).toBe("http://plain:80");
	});

	// The per-request view is the only place a NO_PROXY exemption becomes
	// visible: one request quietly going direct while the rest are proxied.
	test("returns null for a host exempted by NO_PROXY", () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		vi.stubEnv("NO_PROXY", "*.viettel.vn");
		expect(proxyForUrl("https://netmind.viettel.vn/x")).toBeNull();
		expect(proxyForUrl("https://other.example.com/x")).toBe(
			"http://10.0.0.1:8080",
		);
	});

	test("masks credentials", () => {
		vi.stubEnv("HTTPS_PROXY", "http://user:hunter2@10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		expect(proxyForUrl("https://api.example.com/x")).toBe(
			"http://user:***@10.0.0.1:8080",
		);
	});

	test("an unparseable URL is not attributed to a proxy", () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		expect(proxyForUrl("not a url")).toBeNull();
	});
});

/**
 * Windows environment variables are case-insensitive, so `http_proxy` and
 * `HTTP_PROXY` are one variable — but a plain `{...process.env, HTTP_PROXY: x}`
 * yields an object holding both the user's original key (old value) and ours.
 * Handing that to spawnSync leaves which one wins to chance, and a stale win
 * means the proxy retry silently tests an address the user never typed.
 */
describe("child environment overrides", () => {
	test("replaces the value and removes every other spelling", () => {
		const env: NodeJS.ProcessEnv = {
			http_proxy: "http://stale:1",
			HTTP_Proxy: "http://also-stale:2",
			PATH: "/usr/bin",
		};
		overrideEnvVar(env, "HTTP_PROXY", "http://fresh:8080");
		expect(envVarKeys(env, "HTTP_PROXY")).toEqual(["HTTP_PROXY"]);
		expect(env.HTTP_PROXY).toBe("http://fresh:8080");
		// Unrelated variables survive untouched.
		expect(env.PATH).toBe("/usr/bin");
	});

	test("setting a variable that is not present just adds it", () => {
		const env: NodeJS.ProcessEnv = {};
		overrideEnvVar(env, "NODE_USE_ENV_PROXY", "1");
		expect(env).toEqual({ NODE_USE_ENV_PROXY: "1" });
	});

	test("envVarKeys finds every spelling and nothing else", () => {
		const env: NodeJS.ProcessEnv = {
			NO_PROXY: "a",
			no_proxy: "b",
			NOT_A_PROXY: "c",
		};
		expect(envVarKeys(env, "NO_PROXY").sort()).toEqual([
			"NO_PROXY",
			"no_proxy",
		]);
		expect(envVarKeys(env, "MISSING")).toEqual([]);
	});
});
