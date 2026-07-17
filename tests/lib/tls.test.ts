import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	applySystemCaCertsOnce,
	childCaEnv,
	describeNetworkError,
	ensureSystemCaBundle,
	isCertError,
	outputHasCertError,
	resetSystemCaCertsCache,
	systemCaBundlePath,
	tlsApi,
} from "@/lib/tls.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-tls-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
	// A stray real NODE_EXTRA_CA_CERTS in the dev's shell would make childCaEnv
	// bow out and quietly neuter these cases.
	vi.stubEnv("NODE_EXTRA_CA_CERTS", undefined);
});

afterEach(() => {
	resetSystemCaCertsCache();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

// Node hands back the two stores in different shapes: the bundled Mozilla certs
// have NO trailing newline, the OS store's do. Fixtures must keep that skew —
// making them uniform is what let a bundle ship that OpenSSL rejected outright.
const PEM_A = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----";
const PEM_B = "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n";

// Builds the error Node's fetch actually throws: a bare `fetch failed` with the
// real reason hidden on `cause`.
function fetchError(code: string, message: string): Error {
	const err = new TypeError("fetch failed");
	const cause: NodeJS.ErrnoException = new Error(message);
	cause.code = code;
	err.cause = cause;
	return err;
}

describe("applySystemCaCertsOnce", () => {
	test("merges the OS store into the default set, keeping the defaults", () => {
		const set = vi
			.spyOn(tlsApi, "setDefaultCACertificates")
			.mockImplementation(() => {});
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? ["sys-a", "sys-b"] : ["def-a"],
		);

		const result = applySystemCaCertsOnce();

		expect(result?.status).toBe("merged");
		expect(result?.systemCount).toBe(2);
		// "default" already folds in NODE_EXTRA_CA_CERTS — dropping it would break
		// users who fixed their proxy the documented way.
		expect(set).toHaveBeenCalledWith(["def-a", "sys-a", "sys-b"]);
	});

	// The null is what bounds loggedFetch's retry: a chain that stays untrusted
	// after the merge must surface its error, not re-request forever.
	test("runs at most once per process, returning null afterwards", () => {
		const get = vi
			.spyOn(tlsApi, "getCACertificates")
			.mockImplementation((type) => (type === "system" ? ["sys"] : ["def"]));
		vi.spyOn(tlsApi, "setDefaultCACertificates").mockImplementation(() => {});

		expect(applySystemCaCertsOnce()?.status).toBe("merged");
		expect(applySystemCaCertsOnce()).toBeNull();
		expect(applySystemCaCertsOnce()).toBeNull();
		// 2 = one "system" + one "default" from the single real run.
		expect(get).toHaveBeenCalledTimes(2);
	});

	test("reports unsupported on a Node without the CA APIs, without touching TLS", () => {
		vi.spyOn(tlsApi, "supported").mockReturnValue(false);
		const set = vi.spyOn(tlsApi, "setDefaultCACertificates");

		expect(applySystemCaCertsOnce()?.status).toBe("unsupported");
		expect(set).not.toHaveBeenCalled();
	});

	test("leaves the default set alone when the OS store is empty", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockReturnValue([]);
		const set = vi.spyOn(tlsApi, "setDefaultCACertificates");

		expect(applySystemCaCertsOnce()?.status).toBe("empty");
		// Merging an empty system store would replace the defaults with themselves
		// for no reason; skipping keeps Node's behavior byte-identical.
		expect(set).not.toHaveBeenCalled();
	});

	test("swallows a throwing OS store read rather than breaking the command", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation(() => {
			throw new Error("store unreadable");
		});

		const result = applySystemCaCertsOnce();

		expect(result?.status).toBe("failed");
		expect(result?.error).toBe("store unreadable");
	});
});

describe("ensureSystemCaBundle", () => {
	test("writes the complete trust set, not just the corporate root", () => {
		// SSL_CERT_FILE-style consumers replace their store with this file, and a
		// child handed only the proxy root would lose every public CA.
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? [PEM_B] : [PEM_A],
		);

		const path = ensureSystemCaBundle();

		expect(path).toBe(systemCaBundlePath());
		const written = readFileSync(path as string, "utf-8");
		// Every cert newline-terminated exactly once: PEM_A arrives without one
		// and must gain it, PEM_B already has one and must not gain a second.
		expect(written).toBe(`${PEM_A}\n${PEM_B}`);
		expect(written).not.toContain("-----END CERTIFICATE----------BEGIN");
	});

	test("dedupes certs present in both stores", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockReturnValue([PEM_A]);

		const path = ensureSystemCaBundle();

		expect(readFileSync(path as string, "utf-8")).toBe(`${PEM_A}\n`);
	});

	test("writes once per process", () => {
		const get = vi
			.spyOn(tlsApi, "getCACertificates")
			.mockImplementation((type) => (type === "system" ? [PEM_B] : [PEM_A]));

		expect(ensureSystemCaBundle()).toBe(systemCaBundlePath());
		expect(ensureSystemCaBundle()).toBe(systemCaBundlePath());
		expect(get).toHaveBeenCalledTimes(2); // one "system" + one "default"
	});

	test("writes nothing when the OS store is empty or unreadable", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockReturnValue([]);

		expect(ensureSystemCaBundle()).toBeNull();
		expect(existsSync(systemCaBundlePath())).toBe(false);
	});

	test("writes nothing on a Node without the CA APIs", () => {
		vi.spyOn(tlsApi, "supported").mockReturnValue(false);

		expect(ensureSystemCaBundle()).toBeNull();
		expect(existsSync(systemCaBundlePath())).toBe(false);
	});
});

describe("childCaEnv", () => {
	// The whole design rests on this: unaffected users must never get the var,
	// since nothing ever detected interception for them.
	test("is empty until something has written the bundle", () => {
		expect(childCaEnv()).toEqual({});
	});

	test("points children at the bundle once it exists", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? [PEM_B] : [PEM_A],
		);
		ensureSystemCaBundle();

		expect(childCaEnv()).toEqual({ NODE_EXTRA_CA_CERTS: systemCaBundlePath() });
	});

	test("defers to a NODE_EXTRA_CA_CERTS the user set themselves", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? [PEM_B] : [PEM_A],
		);
		ensureSystemCaBundle();

		// The var holds a single path, so ours would silently replace theirs.
		expect(childCaEnv({ NODE_EXTRA_CA_CERTS: "/corp/root.pem" })).toEqual({});
	});
});

describe("outputHasCertError", () => {
	test("matches what npm and other runtimes actually print", () => {
		expect(outputHasCertError("npm error code SELF_SIGNED_CERT_IN_CHAIN")).toBe(
			true,
		);
		expect(
			outputHasCertError(
				"request to https://registry.npmjs.org failed, " +
					"reason: self-signed certificate in certificate chain",
			),
		).toBe(true);
		// OpenSSL only hyphenated "self-signed" in 3.2; older builds print this.
		expect(
			outputHasCertError("self signed certificate in certificate chain"),
		).toBe(true);
		expect(outputHasCertError("unable to get local issuer certificate")).toBe(
			true,
		);
	});

	test("does not fire for ordinary npm failures", () => {
		expect(
			outputHasCertError("npm error 404 Not Found - GET https://x/y"),
		).toBe(false);
		expect(outputHasCertError("npm error network ETIMEDOUT")).toBe(false);
		expect(outputHasCertError("")).toBe(false);
	});
});

describe("isCertError", () => {
	test("recognizes the corporate-proxy chain error", () => {
		expect(
			isCertError(
				fetchError(
					"SELF_SIGNED_CERT_IN_CHAIN",
					"self-signed certificate in certificate chain",
				),
			),
		).toBe(true);
	});

	test("does not fire for DNS/connection failures or bare errors", () => {
		expect(isCertError(fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND"))).toBe(
			false,
		);
		expect(isCertError(new Error("fetch failed"))).toBe(false);
		expect(isCertError("nope")).toBe(false);
	});
});

describe("describeNetworkError", () => {
	test("unwraps Node's bare `fetch failed` to the real reason", () => {
		const msg = describeNetworkError(
			fetchError("ENOTFOUND", "getaddrinfo ENOTFOUND netmind.viettel.vn"),
		);
		expect(msg).toContain("fetch failed");
		expect(msg).toContain("getaddrinfo ENOTFOUND netmind.viettel.vn");
	});

	test("appends a remedy to the corporate-proxy cert error", () => {
		// The exact error users report. Node itself does NOT hint for this code —
		// its --use-system-ca suggestion covers only DEPTH_ZERO/UNABLE_TO_VERIFY_
		// LEAF/UNABLE_TO_GET_ISSUER — so without us it's a dead end.
		const get = vi.spyOn(tlsApi, "getCACertificates");

		const msg = describeNetworkError(
			fetchError(
				"SELF_SIGNED_CERT_IN_CHAIN",
				"self-signed certificate in certificate chain",
			),
		);

		expect(msg).toContain("self-signed certificate in certificate chain");
		expect(msg).toContain("NODE_EXTRA_CA_CERTS");
		// Rendering an error must not touch the OS store: that read is a ~300ms
		// event-loop stall on Windows, and it already ran on the retry path.
		expect(get).not.toHaveBeenCalled();
	});

	test("tells old-Node users to upgrade instead of pointing at the OS store", () => {
		vi.spyOn(tlsApi, "supported").mockReturnValue(false);

		const msg = describeNetworkError(
			fetchError(
				"SELF_SIGNED_CERT_IN_CHAIN",
				"self-signed certificate in certificate chain",
			),
		);

		expect(msg).toContain("Node 22.15+");
		expect(msg).toContain("NODE_EXTRA_CA_CERTS");
	});

	test("does not blame certificates for a plain connection failure", () => {
		const msg = describeNetworkError(
			fetchError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:443"),
		);
		expect(msg).not.toContain("NODE_EXTRA_CA_CERTS");
	});

	test("handles an error with no cause, and a non-Error throw", () => {
		expect(describeNetworkError(new Error("boom"))).toBe("boom");
		expect(describeNetworkError("just a string")).toBe("just a string");
	});
});
