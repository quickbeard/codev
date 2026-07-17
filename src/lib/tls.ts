import tls from "node:tls";

// Node verifies TLS against its own bundled Mozilla CA snapshot and never
// consults the OS trust store (tls.rootCertificates: "fixed at release time…
// identical on all supported platforms"). On a machine behind a TLS-intercepting
// proxy (Zscaler/Netskope/Fortinet) or HTTPS-scanning AV, every chain is
// re-signed by a corporate root that MDM/GPO installed into the *OS* store — so
// browsers work and we fail with `fetch failed (self-signed certificate in
// certificate chain)`.
//
// tls.getCACertificates("system") reads that OS store even without the
// --use-system-ca flag, so merging it into the default set fixes those users
// with no configuration on their side.
//
// Indirection so tests can simulate a Node that predates these APIs (mirrors
// `spawner` in run.ts / `browserOpener` in auth.ts). Not destructured at import:
// on Node < 22.19 these are `undefined`, and a named ESM import of a missing
// builtin export is a link-time error.
export const tlsApi = {
	getCACertificates: (type: string): string[] =>
		(
			tls as unknown as {
				getCACertificates?: (t: string) => string[];
			}
		).getCACertificates?.(type) ?? [],
	setDefaultCACertificates: (certs: string[]): void => {
		(
			tls as unknown as {
				setDefaultCACertificates?: (c: string[]) => void;
			}
		).setDefaultCACertificates?.(certs);
	},
	supported: (): boolean =>
		typeof (tls as unknown as Record<string, unknown>).getCACertificates ===
			"function" &&
		typeof (tls as unknown as Record<string, unknown>)
			.setDefaultCACertificates === "function",
};

export type CaMergeStatus = "merged" | "unsupported" | "empty" | "failed";

export interface CaMergeResult {
	status: CaMergeStatus;
	/** How many certs the OS store contributed. */
	systemCount: number;
	error?: string;
}

let attempted = false;

// Merges the OS trust store into Node's default CA set. Runs at most once per
// process; every later call returns null so a caller can't retry forever.
//
// Deliberately called only *after* a certificate failure, never speculatively.
// The OS-store read is synchronous and costs ~20ms on macOS but ~300ms+ on
// Windows, where it blocks the event loop — enough to stall Ink's render timers.
// Since the users who need this are the minority behind an intercepting proxy,
// and a cert failure is a precise signal that they're one of them, paying on
// failure keeps the happy path at exactly zero cost.
//
// Returns null when a previous call already attempted the merge — the caller
// must not retry the request again, or a permanently untrusted chain would loop.
//
// Best-effort by construction: TLS trust is not this CLI's job to have opinions
// about, and any failure here must leave Node's default behavior exactly as it
// was rather than break a user whose certs already work.
export function applySystemCaCertsOnce(): CaMergeResult | null {
	if (attempted) return null;
	attempted = true;
	return mergeSystemCaCerts();
}

function mergeSystemCaCerts(): CaMergeResult {
	// Node < 22.19 / < 24.5. Those users need --use-system-ca (22.15+) or
	// NODE_EXTRA_CA_CERTS; describeNetworkError tells them so.
	if (!tlsApi.supported()) return { status: "unsupported", systemCount: 0 };
	try {
		const system = tlsApi.getCACertificates("system");
		if (system.length === 0) return { status: "empty", systemCount: 0 };
		// "default" already folds in NODE_EXTRA_CA_CERTS, so a user who fixed this
		// the documented way keeps working — don't narrow this to the bundled set.
		const defaults = tlsApi.getCACertificates("default");
		tlsApi.setDefaultCACertificates([...defaults, ...system]);
		return { status: "merged", systemCount: system.length };
	} catch (err) {
		return {
			status: "failed",
			systemCount: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// Test-only: forget that the merge ran so each case starts clean.
export function resetSystemCaCertsCache(): void {
	attempted = false;
}

// OpenSSL verify failures that mean "I don't trust this chain", as opposed to
// DNS/connection/timeout errors. Node surfaces them on `err.cause.code`.
const CERT_ERROR_CODES = new Set([
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_UNTRUSTED",
	"SELF_SIGNED_CERT_IN_CHAIN_ERR",
]);

// True when a thrown fetch error bottoms out in "I don't trust this chain".
// Node's fetch hides the reason on `err.cause`, so unwrap before matching.
export function isCertError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const cause = err.cause;
	if (!(cause instanceof Error)) return false;
	const code = (cause as NodeJS.ErrnoException).code;
	return code !== undefined && CERT_ERROR_CODES.has(code);
}

// Pure: reading the OS store here would put a ~300ms Windows stall on the error
// path just to word a sentence. By the time this runs, loggedFetch has already
// tried the merge and retried, so "not in your store either" is accurate.
function certHint(): string {
	if (!tlsApi.supported()) {
		return (
			`This looks like a TLS-intercepting proxy or antivirus. Node ${process.version} ` +
			"can't read your system certificate store — upgrade to Node 22.15+ and re-run, " +
			"or point NODE_EXTRA_CA_CERTS at your organization's root CA (PEM file)."
		);
	}
	// The merge ran and the chain still isn't trusted, so the intercepting root
	// isn't in the OS store either — pointing at --use-system-ca would be a dead
	// end. Only the explicit PEM can help.
	return (
		"This looks like a TLS-intercepting proxy or antivirus, and its root CA isn't " +
		"in your system certificate store. Ask IT for the root CA and point " +
		"NODE_EXTRA_CA_CERTS at it (a PEM file), then re-run."
	);
}

// Renders a network error for humans.
//
// Node's fetch throws a bare `TypeError: fetch failed` and hides the real reason
// (DNS, TLS, proxy) on `err.cause` — so unwrap it. For certificate failures,
// append the remedy: Node only volunteers its own --use-system-ca hint for
// DEPTH_ZERO_SELF_SIGNED_CERT / UNABLE_TO_VERIFY_LEAF_SIGNATURE /
// UNABLE_TO_GET_ISSUER_CERT, which pointedly excludes SELF_SIGNED_CERT_IN_CHAIN
// — the corporate-proxy case this exists for. Those users get a dead-end string
// unless we say something.
export function describeNetworkError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const cause: unknown = err.cause;
	const causeMsg =
		cause instanceof Error
			? cause.message
			: cause !== undefined
				? String(cause)
				: "";
	const base = causeMsg ? `${err.message} (${causeMsg})` : err.message;
	return isCertError(err) ? `${base}\n${certHint()}` : base;
}
