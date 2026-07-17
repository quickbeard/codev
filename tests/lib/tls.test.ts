import { afterEach, describe, expect, test, vi } from "vitest";
import {
	describeNetworkError,
	ensureSystemCaCerts,
	resetSystemCaCertsCache,
	tlsApi,
} from "@/lib/tls.js";

afterEach(() => {
	resetSystemCaCertsCache();
	vi.restoreAllMocks();
});

// Builds the error Node's fetch actually throws: a bare `fetch failed` with the
// real reason hidden on `cause`.
function fetchError(code: string, message: string): Error {
	const err = new TypeError("fetch failed");
	const cause: NodeJS.ErrnoException = new Error(message);
	cause.code = code;
	err.cause = cause;
	return err;
}

describe("ensureSystemCaCerts", () => {
	test("merges the OS store into the default set, keeping the defaults", () => {
		const set = vi
			.spyOn(tlsApi, "setDefaultCACertificates")
			.mockImplementation(() => {});
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? ["sys-a", "sys-b"] : ["def-a"],
		);

		const result = ensureSystemCaCerts();

		expect(result.status).toBe("merged");
		expect(result.systemCount).toBe(2);
		// "default" already folds in NODE_EXTRA_CA_CERTS — dropping it would break
		// users who fixed their proxy the documented way.
		expect(set).toHaveBeenCalledWith(["def-a", "sys-a", "sys-b"]);
	});

	test("runs once per process and caches the result", () => {
		const get = vi
			.spyOn(tlsApi, "getCACertificates")
			.mockImplementation((type) => (type === "system" ? ["sys"] : ["def"]));
		vi.spyOn(tlsApi, "setDefaultCACertificates").mockImplementation(() => {});

		const first = ensureSystemCaCerts();
		const second = ensureSystemCaCerts();

		expect(second).toBe(first);
		// 2 = one "system" + one "default" from the single real run.
		expect(get).toHaveBeenCalledTimes(2);
	});

	test("reports unsupported on a Node without the CA APIs, without touching TLS", () => {
		vi.spyOn(tlsApi, "supported").mockReturnValue(false);
		const set = vi.spyOn(tlsApi, "setDefaultCACertificates");

		expect(ensureSystemCaCerts().status).toBe("unsupported");
		expect(set).not.toHaveBeenCalled();
	});

	test("leaves the default set alone when the OS store is empty", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockReturnValue([]);
		const set = vi.spyOn(tlsApi, "setDefaultCACertificates");

		expect(ensureSystemCaCerts().status).toBe("empty");
		// Merging an empty system store would replace the defaults with themselves
		// for no reason; skipping keeps Node's behavior byte-identical.
		expect(set).not.toHaveBeenCalled();
	});

	test("swallows a throwing OS store read rather than breaking the command", () => {
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation(() => {
			throw new Error("store unreadable");
		});

		const result = ensureSystemCaCerts();

		expect(result.status).toBe("failed");
		expect(result.error).toBe("store unreadable");
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
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? ["sys"] : ["def"],
		);
		vi.spyOn(tlsApi, "setDefaultCACertificates").mockImplementation(() => {});

		const msg = describeNetworkError(
			fetchError(
				"SELF_SIGNED_CERT_IN_CHAIN",
				"self-signed certificate in certificate chain",
			),
		);

		expect(msg).toContain("self-signed certificate in certificate chain");
		expect(msg).toContain("NODE_EXTRA_CA_CERTS");
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
