import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as backend from "@/lib/backend.js";
import {
	buildNextSteps,
	type CheckOutcome,
	DOCTOR_PROXY_ENV,
	describeFailure,
	diagnoseError,
	diagnoseExec,
	diagnoseResponse,
	ENVIRONMENT_CHECKS,
	hasFailure,
	INTERNAL_NPM_REGISTRY,
	isTransportError,
	LLM_CHECKS,
	NETWORK_CHECKS,
	normalizeProxyInput,
	PREFLIGHT_CHECKS,
	persistProxyInstructions,
	renderDiagnosisCompact,
	rerunDoctorWithProxy,
	runChecks,
} from "@/lib/doctor.js";
import * as log from "@/lib/log.js";
import * as npm from "@/lib/npm.js";
import * as proxy from "@/lib/proxy.js";
import { PROXY_APPLIED_ENV } from "@/lib/proxy.js";
import * as reexec from "@/lib/reexec.js";
import * as tls from "@/lib/tls.js";

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
	// A maintainer's own proxy settings would otherwise change which branch of
	// every diagnosis is taken.
	for (const name of PROXY_VARS) vi.stubEnv(name, "");
	proxy.resetProxyState();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

/**
 * Build the shape Node's `fetch` actually throws: a bare `TypeError: fetch
 * failed` wrapping the real error, which carries the code and syscall details.
 * Hand-rolling `new Error("ECONNREFUSED")` would test a shape that never occurs.
 */
function fetchError(
	code: string,
	message: string,
	extra: Record<string, unknown> = {},
): TypeError {
	const outer = new TypeError("fetch failed");
	const inner = Object.assign(new Error(message), { code, ...extra });
	(outer as Error & { cause?: unknown }).cause = inner;
	return outer;
}

function rendered(d: ReturnType<typeof diagnoseError>): string {
	return [d.what, d.cause, d.fix, ...d.context, ...d.raw].join("\n");
}

describe("diagnoseError", () => {
	// Table-driven: every code we claim to explain must produce all four parts.
	const CASES: [string, TypeError, RegExp][] = [
		[
			"ENOTFOUND",
			fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com", {
				syscall: "getaddrinfo",
				hostname: "api.example.com",
			}),
			/could not resolve/i,
		],
		[
			"EAI_AGAIN",
			fetchError("EAI_AGAIN", "getaddrinfo EAI_AGAIN api.example.com", {
				hostname: "api.example.com",
			}),
			/could not resolve/i,
		],
		[
			"ECONNREFUSED",
			fetchError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:8080", {
				address: "10.0.0.1",
				port: 8080,
			}),
			/connection refused/i,
		],
		[
			"ETIMEDOUT",
			fetchError("ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:8080", {
				address: "10.0.0.1",
			}),
			/timed out/i,
		],
		[
			"UND_ERR_CONNECT_TIMEOUT",
			fetchError("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"),
			/timed out/i,
		],
		[
			"ECONNRESET",
			fetchError("ECONNRESET", "read ECONNRESET"),
			/reset mid-handshake/i,
		],
		[
			"EPROTO",
			fetchError("EPROTO", "write EPROTO ... ssl3_read_bytes"),
			/reset mid-handshake/i,
		],
		[
			"CERT_HAS_EXPIRED",
			fetchError("CERT_HAS_EXPIRED", "certificate has expired"),
			/expired TLS certificate/i,
		],
		[
			"ERR_TLS_CERT_ALTNAME_INVALID",
			fetchError("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match"),
			/different hostname/i,
		],
		[
			"SELF_SIGNED_CERT_IN_CHAIN",
			fetchError(
				"SELF_SIGNED_CERT_IN_CHAIN",
				"self-signed certificate in certificate chain",
			),
			/does not trust the TLS certificate/i,
		],
	];

	test.each(
		CASES,
	)("%s produces a complete diagnosis", (_name, err, matcher) => {
		const d = diagnoseError(err, {
			url: "https://api.example.com/x",
			method: "GET",
			timeoutMs: 20_000,
		});
		expect(d.what).toMatch(matcher);
		// All four parts must be populated — a blank field is a silent regression
		// back towards "fetch failed".
		expect(d.what.length).toBeGreaterThan(10);
		expect(d.cause.length).toBeGreaterThan(10);
		expect(d.fix.length).toBeGreaterThan(10);
		expect(d.context.length).toBeGreaterThan(0);
		expect(d.raw.length).toBeGreaterThan(0);
	});

	// The guard that gives the whole feature its point.
	test.each(CASES)("%s never renders a bare `fetch failed`", (_n, err) => {
		const d = diagnoseError(err, { url: "https://api.example.com/x" });
		expect(d.what).not.toBe("fetch failed");
		expect(d.what).not.toMatch(/^fetch failed/);
		// The raw chain may (and should) still contain it verbatim — that's the
		// point of the raw section — but never the explanation.
		expect(d.raw.join("\n")).toContain("fetch failed");
	});

	test("preserves the full cause chain verbatim, with codes and syscalls", () => {
		const d = diagnoseError(
			fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com", {
				syscall: "getaddrinfo",
				hostname: "api.example.com",
			}),
		);
		const raw = d.raw.join("\n");
		expect(raw).toContain("TypeError: fetch failed");
		expect(raw).toContain("getaddrinfo ENOTFOUND api.example.com");
		expect(raw).toContain("code ENOTFOUND");
		expect(raw).toContain("syscall getaddrinfo");
	});

	// Node emits one entry per address family when a host has both A and AAAA
	// records, and the real reason lives inside the AggregateError.
	test("unwraps an AggregateError from a dual-stack connect", () => {
		const outer = new TypeError("fetch failed");
		const agg = new AggregateError(
			[
				Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
					code: "ECONNREFUSED",
					address: "127.0.0.1",
					port: 9,
				}),
				Object.assign(new Error("connect ECONNREFUSED ::1:9"), {
					code: "ECONNREFUSED",
				}),
			],
			"",
		);
		(outer as Error & { cause?: unknown }).cause = agg;

		const d = diagnoseError(outer);
		expect(d.what).toMatch(/connection refused/i);
		expect(d.what).toContain("127.0.0.1:9");
	});

	// AbortSignal.timeout's own message names neither host nor duration.
	test("a real AbortSignal.timeout names the URL and the elapsed budget", async () => {
		const signal = AbortSignal.timeout(1);
		const err = await new Promise<unknown>((resolve) => {
			signal.addEventListener("abort", () => resolve(signal.reason));
		});
		const d = diagnoseError(err, {
			url: "https://api.example.com/x",
			timeoutMs: 20_000,
		});
		expect(d.what).toMatch(/no response/i);
		expect(d.what).toContain("api.example.com");
		expect(d.what).toContain("20s");
	});

	// Code that catches and re-throws routinely drops .code but keeps the text.
	test("recovers the code and host from the message when properties are lost", () => {
		const outer = new TypeError("fetch failed");
		(outer as Error & { cause?: unknown }).cause = new Error(
			"getaddrinfo ENOTFOUND sso.example.com",
		);
		const d = diagnoseError(outer);
		expect(d.what).toMatch(/could not resolve/i);
		expect(d.what).toContain("sso.example.com");
	});

	// Regression: an HTTP error our own code threw has no `.cause` and no
	// errno, so it fell through to the generic branch and was reported as
	// "No proxy is configured. If this network requires one, that is the most
	// likely cause." — telling a user whose network is demonstrably fine (the
	// server just answered them) to configure a proxy.
	describe("application-level errors are not blamed on the network", () => {
		test("a backend 401 is reported as an auth result, not a proxy problem", () => {
			const d = diagnoseError(
				new Error(
					"Backend /auth/exchange failed (401): Invalid or expired SSO token",
				),
				{ url: "https://api.example.com/auth/exchange", method: "POST" },
			);
			expect(d.what).toContain("Invalid or expired SSO token");
			expect(d.cause).toMatch(/rejected the credentials/i);
			expect(d.fix).toContain("codevhub login --force");
			// The proxy must not appear anywhere in the explanation.
			expect(d.cause).not.toMatch(/proxy/i);
			expect(d.fix).not.toMatch(/proxy/i);
		});

		test("a non-auth backend error points at the server's own message", () => {
			const d = diagnoseError(
				new Error("Backend /config returned incomplete payload: {}"),
			);
			expect(d.cause).toMatch(/answered/i);
			expect(d.fix).not.toMatch(/HTTP_PROXY/);
		});

		// A proxy IS the likely cause when nothing answered, so that reasoning
		// must survive for errors that really did come from the transport.
		test("a transport error keeps its proxy reasoning", () => {
			const d = diagnoseError(
				fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com"),
			);
			expect(d.fix).toContain("HTTP_PROXY");
		});

		// An errno in the message with no `cause` is still a network failure.
		test("a causeless error naming an errno is still diagnosed as network", () => {
			const d = diagnoseError(new Error("connect ECONNREFUSED 10.0.0.1:8080"));
			expect(d.what).toMatch(/connection refused/i);
		});
	});

	test("an unknown code still explains itself rather than echoing the error", () => {
		const d = diagnoseError(fetchError("E_WEIRD", "something odd happened"), {
			url: "https://api.example.com/x",
		});
		expect(d.what).toContain("something odd happened");
		expect(d.cause.length).toBeGreaterThan(10);
		expect(d.fix.length).toBeGreaterThan(10);
	});

	describe("proxy state shapes the explanation", () => {
		test("no proxy set → tells the user to configure one", () => {
			const d = diagnoseError(
				fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com"),
			);
			expect(d.fix).toContain("HTTP_PROXY");
			expect(rendered(d)).toContain("proxy: none");
		});

		// The single most common silent failure: a proxy is set and Node ignores
		// it. That must dominate the explanation, because nothing else can be
		// diagnosed until it is fixed.
		test("proxy set but NODE_USE_ENV_PROXY unset → that is the fix", () => {
			vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
			const d = diagnoseError(
				fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com"),
			);
			expect(d.fix).toContain("NODE_USE_ENV_PROXY=1");
			expect(d.cause).toContain("IGNORING your proxy settings");
			expect(rendered(d)).toContain("NODE_USE_ENV_PROXY: unset");
		});

		test("proxy active → ECONNREFUSED is read as a wrong proxy address", () => {
			vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
			vi.stubEnv("NODE_USE_ENV_PROXY", "1");
			const d = diagnoseError(
				fetchError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:8080", {
					address: "10.0.0.1",
					port: 8080,
				}),
			);
			expect(d.cause).toMatch(/that address is your proxy/i);
			expect(d.fix).toContain("HTTP_PROXY");
		});

		// Without an address in the error we fall back to the request host, and
		// claiming the *destination* is the proxy contradicts the line above it.
		test("an addressless refusal does not call the destination the proxy", () => {
			vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
			vi.stubEnv("NODE_USE_ENV_PROXY", "1");
			const d = diagnoseError(
				fetchError("ECONNREFUSED", "connect ECONNREFUSED"),
				{ url: "https://api.example.com/x" },
			);
			expect(d.what).toContain("api.example.com");
			expect(d.cause).not.toContain("That address is your proxy");
			expect(d.cause).toMatch(/most likely came from the proxy/i);
		});

		test("a NO_PROXY exemption for the backend is reported in the context", () => {
			vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
			vi.stubEnv("NODE_USE_ENV_PROXY", "1");
			vi.stubEnv("NO_PROXY", "*.viettel.vn");
			const d = diagnoseError(fetchError("ETIMEDOUT", "connect ETIMEDOUT"));
			expect(rendered(d)).toContain("*.viettel.vn");
		});
	});

	test("redacts credentials that appear in an error message", () => {
		const d = diagnoseError(
			fetchError(
				"E_WEIRD",
				"rejected request with Authorization: Bearer abc123def456ghi",
			),
		);
		const all = rendered(d);
		expect(all).not.toContain("abc123def456ghi");
		expect(all).toContain("[REDACTED]");
	});
});

describe("diagnoseResponse", () => {
	function headers(init: Record<string, string> = {}): Headers {
		return new Headers(init);
	}

	test("407 explains proxy authentication and how to supply credentials", () => {
		const d = diagnoseResponse(
			407,
			"Proxy Authentication Required",
			headers({ "proxy-authenticate": "Basic realm=corp" }),
			"",
			{ url: "https://api.example.com/x" },
		);
		expect(d.what).toContain("407");
		expect(d.fix).toContain("user:password@host:port");
		expect(d.raw.join("\n")).toContain("Basic realm=corp");
	});

	// The documented npm-403 case: it reads as a permissions problem but is the
	// network blocking the request.
	test("403 with proxy signatures is attributed to the network, not the account", () => {
		const d = diagnoseResponse(
			403,
			"Forbidden",
			headers({ via: "1.1 corp-proxy" }),
			"blocked by policy",
			{ url: "https://registry.npmjs.org/x" },
		);
		expect(d.cause).toMatch(/network blocking/i);
		expect(d.fix).toContain("unset");
	});

	test("502 is attributed to the proxy rather than a CoDev outage", () => {
		const d = diagnoseResponse(502, "Bad Gateway", headers(), "", {
			url: "https://api.example.com/x",
		});
		expect(d.cause).toMatch(/proxy failing to reach/i);
	});

	test("truncates a huge error body so it can't blow up the frame", () => {
		const d = diagnoseResponse(
			500,
			"Server Error",
			headers(),
			"x".repeat(5000),
		);
		expect(d.raw.join("\n").length).toBeLessThan(1000);
	});

	test("redacts a bearer token echoed back in an error body", () => {
		const d = diagnoseResponse(
			401,
			"Unauthorized",
			headers(),
			'{"error":"bad token: Bearer supersecrettokenvalue"}',
		);
		const all = d.raw.join("\n");
		expect(all).not.toContain("supersecrettokenvalue");
		expect(all).toContain("[REDACTED]");
	});
});

describe("diagnoseExec", () => {
	test("ENOENT is reported as a missing program, not a failed command", () => {
		const d = diagnoseExec("npm -v", "ENOENT", "", true);
		expect(d.what).toContain("not found on your PATH");
		expect(d.fix).toContain("nodejs.org");
	});

	// npm's stderr names the registry, proxy and .npmrc in play — truncating it
	// destroys the diagnosis, so it must survive in full.
	test("keeps npm's stderr in full", () => {
		const stderr = Array.from(
			{ length: 60 },
			(_, i) => `npm ERR! line ${i}`,
		).join("\n");
		const d = diagnoseExec("npm ping", 1, stderr, false);
		expect(d.raw).toHaveLength(60);
		expect(d.raw.at(-1)).toContain("line 59");
	});

	test("E403 gets the documented unset-proxy-in-this-shell fix", () => {
		const d = diagnoseExec("npm ping", 1, "npm ERR! code E403", false);
		expect(d.fix).toContain("unset HTTPS_PROXY HTTP_PROXY");
		expect(d.fix).toContain("$env:HTTPS_PROXY = $null");
	});

	test("EACCES points at a writable prefix, not sudo", () => {
		const d = diagnoseExec("npm i -g x", 1, "npm ERR! EACCES denied", false);
		expect(d.fix).toContain("npm config set prefix");
		expect(d.fix).toMatch(/avoid `sudo npm i -g`/i);
	});

	test("a TLS failure points at npm's own cafile, not Node's env vars", () => {
		const d = diagnoseExec(
			"npm ping",
			1,
			"npm ERR! request to https://registry.npmjs.org failed, reason: self-signed certificate in certificate chain",
			false,
		);
		expect(d.fix).toContain("npm config set cafile");
	});

	test("a network failure names the internal registry mirror", () => {
		const d = diagnoseExec("npm ping", 1, "npm ERR! ETIMEDOUT", false);
		expect(d.fix).toContain(INTERNAL_NPM_REGISTRY);
	});
});

describe("describeFailure", () => {
	test("upgrades a transport error to the full diagnosis", () => {
		const msg = describeFailure(
			fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com"),
		);
		expect(msg).toMatch(/could not resolve/i);
		expect(msg).toContain("Fix:");
	});

	// A backend HTTP error already has a precise message; wrapping it in
	// proxy-oriented reasoning would be actively misleading.
	test("leaves a plain backend error message alone", () => {
		const err = new Error("Backend /config failed (403): forbidden");
		expect(isTransportError(err)).toBe(false);
		expect(describeFailure(err)).toBe(
			"Backend /config failed (403): forbidden",
		);
	});
});

describe("environment checks", () => {
	test("the pre-flight subset is pure — no subprocess, no OS trust store", async () => {
		const exec = vi.spyOn(npm, "execAsync");
		const ca = vi.spyOn(tls.tlsApi, "getCACertificates");
		await runChecks(PREFLIGHT_CHECKS, {});
		// Both are load-bearing: `npm config get` costs ~300ms apiece, and the
		// OS-store read blocks the event loop for 300ms+ on Windows, which is
		// exactly what stalls Ink's render timers (see lib/tls.ts).
		expect(exec).not.toHaveBeenCalled();
		expect(ca).not.toHaveBeenCalled();
	});

	test("the pre-flight subset is a subset of the full environment group", () => {
		for (const check of PREFLIGHT_CHECKS) {
			expect(ENVIRONMENT_CHECKS).toContain(check);
		}
	});

	async function runOne(key: string): Promise<CheckOutcome> {
		const check = ENVIRONMENT_CHECKS.find((c) => c.key === key);
		if (!check) throw new Error(`no such check: ${key}`);
		const [outcome] = await runChecks([check], {});
		if (!outcome) throw new Error("no outcome");
		return outcome;
	}

	test("node-version passes on the Node running the suite", async () => {
		// The suite can only run on a supported Node, so this pins that the
		// check agrees with the startup gate rather than drifting from it.
		expect((await runOne("node-version")).status).toBe("pass");
	});

	test("proxy-env warns when a proxy is set without NODE_USE_ENV_PROXY", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		const o = await runOne("proxy-env");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain("NODE_USE_ENV_PROXY");
	});

	test("proxy-env warns about a NO_PROXY entry covering the backend", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		vi.stubEnv("NODE_USE_SYSTEM_CA", "1");
		vi.stubEnv("NO_PROXY", "*.viettel.vn");
		const o = await runOne("proxy-env");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain("*.viettel.vn");
		expect(o.fix).toContain("Login failed");
	});

	// Accuracy matters more than brevity here: claiming Node ignores the proxy,
	// on a run where CoDev enabled it, contradicts the evidence in the same
	// report. The advice must shift to "set it for npm and the agents".
	test("proxy-env explains an auto-enabled proxy without claiming it is ignored", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		vi.stubEnv("NODE_USE_SYSTEM_CA", "1");
		vi.spyOn(proxy, "proxyAutoEnabled").mockReturnValue(true);
		const o = await runOne("proxy-env");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain("CoDev enabled proxy support for this run");
		expect(o.fix).not.toContain("Node ignores proxy environment variables");
	});

	test("proxy-env flags disabled TLS verification", async () => {
		vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
		const o = await runOne("proxy-env");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
	});

	test("proxy-env passes on a clean environment", async () => {
		expect((await runOne("proxy-env")).status).toBe("pass");
	});

	test("npm-available fails with an install hint when npm is missing", async () => {
		vi.spyOn(npm, "execAsync").mockResolvedValue({
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }),
		});
		const o = await runOne("npm-available");
		expect(o.status).toBe("fail");
		expect(o.diagnosis?.what).toContain("not found on your PATH");
	});

	test("npm-registry warns when the shell has a proxy but npm does not", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.spyOn(npm, "execAsync").mockImplementation(async (_f, args) => ({
			stdout: args[2] === "registry" ? INTERNAL_NPM_REGISTRY : "undefined",
			stderr: "",
			error: null,
		}));
		const o = await runOne("npm-registry");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain("npm config set proxy");
	});

	test("npm-registry warns when pointed at the public registry", async () => {
		vi.spyOn(npm, "execAsync").mockImplementation(async (_f, args) => ({
			stdout:
				args[2] === "registry" ? "https://registry.npmjs.org/" : "undefined",
			stderr: "",
			error: null,
		}));
		const o = await runOne("npm-registry");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain(INTERNAL_NPM_REGISTRY);
	});

	test("system-ca warns on a Node that cannot read the OS store", async () => {
		vi.spyOn(tls.tlsApi, "supported").mockReturnValue(false);
		const o = await runOne("system-ca");
		expect(o.status).toBe("warn");
		expect(o.fix).toContain("NODE_EXTRA_CA_CERTS");
	});

	test("system-ca warns when the store is empty", async () => {
		vi.spyOn(tls.tlsApi, "supported").mockReturnValue(true);
		vi.spyOn(tls.tlsApi, "getCACertificates").mockReturnValue([]);
		expect((await runOne("system-ca")).status).toBe("warn");
	});
});

// Regression: the probe used to GET the API base path and let `fetch` follow
// redirects. The gateway 301s that path to its internal origin
// (`http://netmind.viettel.vn:9096/codev-backend/`), which is unreachable from
// outside the corporate network — so `doctor` reported the backend down on
// machines where `codevhub install` worked perfectly.
describe("backend reachability probe", () => {
	async function runReach(): Promise<CheckOutcome> {
		const check = NETWORK_CHECKS.find((c) => c.key === "backend-reach");
		if (!check) throw new Error("no backend-reach check");
		const [outcome] = await runChecks([check], {});
		if (!outcome) throw new Error("no outcome");
		return outcome;
	}

	test("never follows redirects, and hits a real route rather than the base path", async () => {
		const fetchSpy = vi
			.spyOn(log, "loggedFetch")
			.mockResolvedValue(new Response("", { status: 401 }));

		await runReach();

		const [, url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(init?.redirect).toBe("manual");
		expect(init?.method).toBe("POST");
		// The bare base path is exactly what 301s to the internal origin.
		expect(String(url)).not.toMatch(/\/codev-backend\/?$/);
		expect(String(url)).toContain("/codev-backend/config");
	});

	test("a redirect counts as reachable — the response itself proves transport", async () => {
		vi.spyOn(log, "loggedFetch").mockResolvedValue(
			new Response("", {
				status: 301,
				headers: { location: "http://netmind.viettel.vn:9096/codev-backend/" },
			}),
		);
		expect((await runReach()).status).toBe("pass");
	});

	test("401 is a pass, and says so rather than reading like a failure", async () => {
		vi.spyOn(log, "loggedFetch").mockResolvedValue(
			new Response("", { status: 401 }),
		);
		const o = await runReach();
		expect(o.status).toBe("pass");
		expect(o.detail).toContain("expected without credentials");
	});

	test("407 still fails — a proxy challenge means the transport is unusable", async () => {
		vi.spyOn(log, "loggedFetch").mockResolvedValue(
			new Response("", { status: 407 }),
		);
		const o = await runReach();
		expect(o.status).toBe("fail");
		expect(o.fix).toContain("user:password@host:port");
	});

	test("a connect timeout still fails, with the full diagnosis", async () => {
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("Connect Timeout Error"), {
					code: "UND_ERR_CONNECT_TIMEOUT",
				}),
			}),
		);
		const o = await runReach();
		expect(o.status).toBe("fail");
		expect(o.diagnosis?.what).toMatch(/timed out/i);
	});
});

describe("llm checks", () => {
	// doctor never writes ~/.codev-hub/auth.json, so every LLM check has to be
	// handed the gateway URL the config check fetched.
	const GATEWAY = "https://gateway.example.com";

	async function runLlm(key: string, ctx: object): Promise<CheckOutcome> {
		const check = LLM_CHECKS.find((c) => c.key === key);
		if (!check) throw new Error(`no such check: ${key}`);
		const [outcome] = await runChecks([check], ctx);
		if (!outcome) throw new Error("no outcome");
		return outcome;
	}

	test("skips cleanly when there is no API key", async () => {
		const o = await runLlm("gateway-key", {});
		expect(o.status).toBe("skip");
	});

	// Regression: these called backend.ts without a base URL, so it fell back to
	// AI_GATEWAY_URL(), which reads ~/.codev-hub/auth.json and throws when it is
	// absent. On a machine that has never run `codevhub install` — the audience
	// this command exists for — all three failed with "Run `codevhub install`":
	// circular advice, and wrong, since the config check had just fetched the
	// URL. `doctor` never writes that cache, so it must be threaded through.
	describe("the gateway URL is threaded, not read from the install cache", () => {
		test.each([
			["gateway-key", () => vi.spyOn(backend, "validateApiKey")],
			["gateway-models", () => vi.spyOn(backend, "fetchModels")],
			["llm-completion", () => vi.spyOn(backend, "smokeTestModel")],
		])("%s passes ctx.gatewayUrl through", async (key, spyFor) => {
			const spy = spyFor();
			// biome-ignore lint/suspicious/noExplicitAny: one spy shape per callee
			(spy as any).mockResolvedValue(
				key === "gateway-models"
					? ["m-alpha"]
					: key === "gateway-key"
						? true
						: null,
			);
			await runLlm(key, {
				apiKey: "k",
				gatewayUrl: "https://gateway.example.com",
				models: ["m-alpha"],
			});
			// The URL must reach backend.ts as an argument — the last one for the
			// completion (apiKey, model, baseUrl), the second otherwise.
			expect(spy.mock.calls[0]).toContain("https://gateway.example.com");
		});

		test.each([
			"gateway-key",
			"gateway-models",
			"llm-completion",
		])("%s skips rather than blaming the install cache when the URL is missing", async (key) => {
			const o = await runLlm(key, { apiKey: "k" });
			expect(o.status).toBe("skip");
			expect(o.detail).not.toContain("auth.json");
			expect(o.detail).not.toContain("codevhub install");
		});
	});

	test("a rejected key fails with a re-auth instruction", async () => {
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		const o = await runLlm("gateway-key", {
			apiKey: "k",
			gatewayUrl: GATEWAY,
		});
		expect(o.status).toBe("fail");
		expect(o.fix).toContain("codevhub login --force");
	});

	// The only check that proves inference is actually permitted — /key/info
	// and /v1/models both pass for a key that is 403'd on every completion.
	test("a gateway completion refusal fails with the reason attached", async () => {
		vi.spyOn(backend, "smokeTestModel").mockResolvedValue(
			"Gateway rejected a test request for m-alpha (HTTP 403): budget exceeded",
		);
		const o = await runLlm("llm-completion", {
			apiKey: "k",
			gatewayUrl: GATEWAY,
			models: ["m-alpha"],
		});
		expect(o.status).toBe("fail");
		expect(o.diagnosis?.raw.join("\n")).toContain("budget exceeded");
		expect(o.diagnosis?.cause).toMatch(/only proves the key exists/i);
	});

	// smokeTestModel stringifies its own errors, so an unreachable gateway
	// arrives as "Couldn't reach the gateway to test X: fetch failed" — the
	// exact bare message this command exists to eliminate.
	test("an unreachable gateway is diagnosed, not echoed as `fetch failed`", async () => {
		vi.spyOn(backend, "smokeTestModel").mockResolvedValue(
			"Couldn't reach the gateway to test m-alpha: fetch failed",
		);
		const o = await runLlm("llm-completion", {
			apiKey: "k",
			gatewayUrl: GATEWAY,
			models: ["m-alpha"],
		});
		expect(o.status).toBe("fail");
		expect(o.detail).toContain("gateway.example.com");
		expect(o.detail).not.toContain("fetch failed");
		expect(o.diagnosis?.cause).toMatch(/connectivity problem/i);
		// The raw string is still preserved for support.
		expect(o.diagnosis?.raw.join("\n")).toContain("fetch failed");
	});

	test("a successful completion passes and names the model", async () => {
		vi.spyOn(backend, "smokeTestModel").mockResolvedValue(null);
		const o = await runLlm("llm-completion", {
			apiKey: "k",
			gatewayUrl: GATEWAY,
			models: ["m-alpha"],
		});
		expect(o.status).toBe("pass");
		expect(o.detail).toContain("m-alpha");
	});
});

describe("runChecks", () => {
	test("a check that throws becomes a failure rather than taking the run down", async () => {
		const outcomes = await runChecks(
			[
				{
					key: "boom",
					label: "Boom",
					group: "environment",
					run: async () => {
						throw new Error("unexpected");
					},
				},
			],
			{},
		);
		expect(outcomes[0]?.status).toBe("fail");
		expect(hasFailure(outcomes)).toBe(true);
	});

	test("threads context forward between checks", async () => {
		const ctx: { apiKey?: string } = {};
		await runChecks(
			[
				{
					key: "a",
					label: "A",
					group: "account",
					run: async (c) => {
						c.apiKey = "from-a";
						return { status: "pass", detail: "" };
					},
				},
				{
					key: "b",
					label: "B",
					group: "llm",
					run: async (c) => ({ status: "pass", detail: c.apiKey ?? "missing" }),
				},
			],
			ctx,
		);
		expect(ctx.apiKey).toBe("from-a");
	});
});

describe("remediation output", () => {
	const failing: CheckOutcome[] = [
		{
			key: "proxy-env",
			label: "Proxy & TLS environment",
			group: "environment",
			status: "warn",
			detail: "…",
			fix: "Set NODE_USE_ENV_PROXY=1.",
		},
		{
			key: "backend-reach",
			label: "Reach the CoDev backend",
			group: "network",
			status: "fail",
			detail: "…",
			fix: "Check the proxy address.",
		},
	];

	test("lists every actionable item and ends pointing at install", () => {
		const lines = buildNextSteps(failing).join("\n");
		expect(lines).toContain("Set NODE_USE_ENV_PROXY=1.");
		expect(lines).toContain("Check the proxy address.");
		expect(lines).toContain("codevhub install");
	});

	// The explicit requirement: users must leave with instructions they can
	// apply before running install.
	test("includes persistent setup instructions when the failure is proxy-related", () => {
		const lines = buildNextSteps(failing, {
			http: "http://10.0.0.1:8080",
			https: "http://10.0.0.1:8080",
		}).join("\n");
		expect(lines).toContain("NODE_USE_ENV_PROXY");
		expect(lines).toContain("10.0.0.1:8080");
		expect(lines).toContain("npm config set proxy");
	});

	// A wall of export lines under an expired-token 401 buries the one
	// instruction that actually helps.
	test("omits proxy setup when the only failures are authentication", () => {
		const lines = buildNextSteps([
			{
				key: "api-key",
				label: "Fetch a gateway API key",
				group: "account",
				status: "fail",
				detail: "Backend /auth/exchange failed (401)",
				fix: "Run `codevhub login --force` to re-authenticate, then re-run.",
			},
		]).join("\n");
		expect(lines).toContain("codevhub login --force");
		expect(lines).not.toContain("export HTTPS_PROXY");
		expect(lines).not.toContain("SetEnvironmentVariable");
	});

	// The internal mirror's URL ends in `/npm-proxy`, which a loose /proxy/i
	// test matched — dragging the whole export block into a run whose only
	// issue was the registry setting.
	test("the npm mirror URL does not count as a proxy problem", () => {
		const lines = buildNextSteps([
			{
				key: "npm-registry",
				label: "npm registry configuration",
				group: "environment",
				status: "warn",
				detail: "registry: https://registry.npmjs.org/",
				fix: `Set the mirror: npm config set registry ${INTERNAL_NPM_REGISTRY}`,
			},
		]).join("\n");
		expect(lines).toContain(INTERNAL_NPM_REGISTRY);
		expect(lines).not.toContain("export HTTPS_PROXY");
		expect(lines).not.toContain("SetEnvironmentVariable");
	});

	// But a transport failure in the same group still warrants them — the
	// signal is the diagnosis naming the proxy vars, not the group.
	test("includes proxy setup when an account failure is a transport failure", () => {
		const lines = buildNextSteps([
			{
				key: "api-key",
				label: "Fetch a gateway API key",
				group: "account",
				status: "fail",
				detail: "Could not resolve api.example.com",
				fix: "Set HTTP_PROXY, HTTPS_PROXY and NODE_USE_ENV_PROXY=1, then re-run.",
			},
		]).join("\n");
		expect(lines).toContain("NODE_USE_ENV_PROXY=1");
		expect(lines).toContain("npm config set proxy");
	});

	test("says nothing when everything passed", () => {
		expect(
			buildNextSteps([
				{
					key: "x",
					label: "X",
					group: "network",
					status: "pass",
					detail: "ok",
				},
			]),
		).toEqual([]);
	});

	test("persist instructions are platform-appropriate", () => {
		const lines = persistProxyInstructions({
			https: "http://10.0.0.1:8080",
		}).join("\n");
		if (process.platform === "win32") {
			expect(lines).toContain("SetEnvironmentVariable");
		} else {
			expect(lines).toContain("export HTTPS_PROXY=");
		}
		// npm's proxy config is separate from the shell's, and users miss this.
		expect(lines).toContain("npm config set https-proxy");
	});
});

// The retry is the one place `doctor` shells out, and what it runs has to be
// exactly reproducible by hand for support. These spell the command out.
describe("the proxy retry command", () => {
	const PROXY = { http: "http://10.0.0.1:8080", https: "http://10.0.0.1:8080" };

	function captureSpawn() {
		return (
			vi
				.spyOn(reexec.spawner, "spawnSync")
				// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
				.mockReturnValue({ status: 0 } as any)
		);
	}

	test("runs `node <cli> doctor`, forwarding argv and node's own flags", () => {
		const spawn = captureSpawn();
		rerunDoctorWithProxy(PROXY, ["--force"]);

		const [file, argv, opts] = spawn.mock.calls[0] ?? [];
		// The whole command, spelled out:
		//   <node> [...node flags] <cli entry> doctor --force
		expect([file, ...(argv as string[])]).toEqual([
			process.execPath,
			...process.execArgv,
			process.argv[1],
			"doctor",
			"--force",
		]);
		// It re-invokes node on the script directly — no shell, no `codevhub` bin.
		expect(file).toBe(process.execPath);
		expect(opts?.shell).toBeUndefined();
		// Inherited stdio is what makes the retry look like one continuous session.
		expect(opts?.stdio).toBe("inherit");
	});

	// Without execArgv a `pnpm dev` run (node + tsx loader flags) would spawn a
	// child that cannot load TypeScript and dies immediately.
	test("forwards node's own exec flags so a tsx dev run still works", () => {
		const spawn = captureSpawn();
		const original = process.execArgv;
		Object.defineProperty(process, "execArgv", {
			value: ["--import", "file:///tmp/tsx/loader.mjs"],
			configurable: true,
		});
		try {
			rerunDoctorWithProxy(PROXY, []);
		} finally {
			Object.defineProperty(process, "execArgv", {
				value: original,
				configurable: true,
			});
		}
		const argv = spawn.mock.calls[0]?.[1] as string[];
		expect(argv.slice(0, 2)).toEqual([
			"--import",
			"file:///tmp/tsx/loader.mjs",
		]);
		expect(argv).toContain("doctor");
	});

	test("sets exactly the environment the retry needs", () => {
		const spawn = captureSpawn();
		rerunDoctorWithProxy(PROXY, []);

		const env = spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
		expect(env.HTTP_PROXY).toBe("http://10.0.0.1:8080");
		expect(env.HTTPS_PROXY).toBe("http://10.0.0.1:8080");
		// Node reads this only at bootstrap, which is the entire reason the retry
		// is a new process rather than an in-place re-run.
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
		// An intercepting proxy re-signs TLS, so trusting the OS store is part of
		// "try it with the proxy", not a separate step.
		expect(env.NODE_USE_SYSTEM_CA).toBe("1");
		// Stops the child prompting again if it still fails.
		expect(env[DOCTOR_PROXY_ENV]).toBe("1");
	});

	// A NO_PROXY entry covering our backend routes that traffic around the very
	// proxy being tested — the documented cause of "Login failed".
	test("drops a NO_PROXY entry that would bypass the proxy under test", () => {
		vi.stubEnv("NO_PROXY", "localhost,*.viettel.vn,127.0.0.1");
		const spawn = captureSpawn();
		rerunDoctorWithProxy(PROXY, []);

		const env = spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
		expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
		// The user's own environment is untouched — only the child's copy changes.
		expect(process.env.NO_PROXY).toBe("localhost,*.viettel.vn,127.0.0.1");
	});

	test("propagates the child's exit code", () => {
		vi.spyOn(reexec.spawner, "spawnSync")
			// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
			.mockReturnValue({ status: 3 } as any);
		expect(rerunDoctorWithProxy(PROXY, [])).toBe(3);
	});

	test("a killed child (null status) is reported as a failure", () => {
		vi.spyOn(reexec.spawner, "spawnSync")
			// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
			.mockReturnValue({ status: null } as any);
		expect(rerunDoctorWithProxy(PROXY, [])).toBe(1);
	});
});

describe("normalizeProxyInput", () => {
	test.each([
		["10.0.0.1:8080", "http://10.0.0.1:8080"],
		["http://10.0.0.1:8080", "http://10.0.0.1:8080"],
		["https://proxy.corp:3128", "https://proxy.corp:3128"],
		["  10.0.0.1:8080  ", "http://10.0.0.1:8080"],
	])("%s → %s", (input, expected) => {
		expect(normalizeProxyInput(input)).toBe(expected);
	});

	test.each([
		["proxy.corp:3128", "http://proxy.corp:3128"],
		// Bracketed IPv6, per normal URL syntax.
		["[::1]:8080", "http://[::1]:8080"],
		// Credentials survive, for proxies that require auth.
		["user:pass@10.0.0.1:8080", "http://user:pass@10.0.0.1:8080"],
	])("%s → %s", (input, expected) => {
		expect(normalizeProxyInput(input)).toBe(expected);
	});

	test.each([
		"",
		"   ",
		"::::",
		"10.0.0.1 8080",
		"10.0.0.1:8080:9",
	])("rejects %s", (input) => {
		expect(normalizeProxyInput(input)).toBeNull();
	});

	// WHATWG URL parses bare integers as 32-bit IPv4 addresses, so `8080`
	// silently became `http://0.0.31.144` — accepted, then failing much later as
	// a timeout to an address the user never typed. Typing only the port is a
	// very plausible slip against a prompt that asks for "host:port".
	test.each([
		"8080",
		"3128",
		"0",
		"http://8080",
	])("rejects the bare port %s instead of coercing it to an IP", (input) => {
		expect(normalizeProxyInput(input)).toBeNull();
	});
});

describe("renderDiagnosisCompact", () => {
	test("keeps the explanation and the fix", () => {
		const out = renderDiagnosisCompact({
			what: "W",
			cause: "C",
			fix: "F",
			context: ["ctx"],
			raw: ["raw"],
		});
		expect(out).toBe("W\nC\nFix: F");
	});
});
