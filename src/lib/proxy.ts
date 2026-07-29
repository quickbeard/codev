import http from "node:http";
import { BACKEND_URL } from "@/lib/const.js";
import { currentTraceId, logInfo, logWarn } from "@/lib/log.js";
import { spawner } from "@/lib/reexec.js";

// Node does NOT honor HTTP_PROXY/HTTPS_PROXY by default. Support is gated behind
// NODE_USE_ENV_PROXY=1 (or --use-env-proxy) and it is read at *bootstrap*, so
// assigning process.env mid-run is too late for the already-initialized global
// dispatcher. Users who follow our install docs and export only
// HTTP_PROXY/HTTPS_PROXY therefore get no proxy at all — silently — and every
// fetch fails with a bare `fetch failed`.
//
// This module closes that gap once, at the CLI entry point, so every command
// (install, login, upload, model, the launch-time key refresh) benefits rather
// than just the one being debugged.
//
// Both the env-var support and http.setGlobalProxyFromEnv() landed together in
// Node 22.21.0 / 24.x — which is exactly why MIN_NODE_VERSION is 22.21.0.

// Indirection so tests can simulate a Node that predates the API (mirrors
// `tlsApi` in tls.ts / `spawner` in reexec.ts). Accessed off the default import
// and never destructured: on older Node this export doesn't exist, and a named
// ESM import of a missing builtin export is a link-time error, not a runtime
// `undefined`.
export const httpApi = {
	setGlobalProxyFromEnv: (): void => {
		(
			http as unknown as { setGlobalProxyFromEnv?: () => void }
		).setGlobalProxyFromEnv?.();
	},
	supported: (): boolean =>
		typeof (http as unknown as Record<string, unknown>)
			.setGlobalProxyFromEnv === "function",
};

// Set on the re-exec child so a Node that somehow still ignores the env var
// can't send us round the loop forever (same guard shape as reexec.ts's
// `process.execArgv.includes("--experimental-sqlite")` check).
export const PROXY_APPLIED_ENV = "CODEV_PROXY_APPLIED";

export interface ProxyEnv {
	/** Raw HTTP_PROXY / http_proxy value, whichever is set. */
	httpProxy: string | null;
	httpsProxy: string | null;
	noProxy: string | null;
	/** NODE_USE_ENV_PROXY is set to something truthy. */
	useEnvProxy: boolean;
	/** NODE_USE_SYSTEM_CA is set to something truthy. */
	useSystemCa: boolean;
	/** Raw NODE_TLS_REJECT_UNAUTHORIZED, so "0" can be reported verbatim. */
	tlsRejectUnauthorized: string | null;
}

// Node accepts either case for the proxy vars (and lowercase is the long-
// standing Unix convention), so read both rather than trusting the docs' casing.
// Each spelling is normalized independently: an empty HTTP_PROXY means "unset"
// and must fall through to http_proxy. A plain `env[upper] ?? env[lower]` only
// falls through on `undefined`, so an exported-but-empty variable would mask a
// perfectly good lowercase one.
function readEither(
	env: NodeJS.ProcessEnv,
	upper: string,
	lower: string,
): string | null {
	return nonEmpty(env[upper]) ?? nonEmpty(env[lower]);
}

function nonEmpty(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

// "1"/"true"/"yes" style. Node itself treats any non-empty value as on, so an
// explicit "0" is deliberately still "set" here — we report what the user did
// rather than second-guessing it.
function isEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

export function readProxyEnv(env: NodeJS.ProcessEnv = process.env): ProxyEnv {
	return {
		httpProxy: readEither(env, "HTTP_PROXY", "http_proxy"),
		httpsProxy: readEither(env, "HTTPS_PROXY", "https_proxy"),
		noProxy: readEither(env, "NO_PROXY", "no_proxy"),
		useEnvProxy: isEnabled(env.NODE_USE_ENV_PROXY),
		useSystemCa: isEnabled(env.NODE_USE_SYSTEM_CA),
		tlsRejectUnauthorized: env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
	};
}

export function hasProxyConfigured(proxy: ProxyEnv): boolean {
	return proxy.httpProxy !== null || proxy.httpsProxy !== null;
}

/**
 * `http://user:hunter2@10.0.0.1:8080` → `http://user:***@10.0.0.1:8080`.
 *
 * Proxy URLs routinely carry credentials, and every place we display one — the
 * check row, the per-request activity lines, the report file — is somewhere a
 * user pastes into a ticket or a chat. Masking happens at the display boundary
 * only: `readProxyEnv` keeps the real value, because the child process of the
 * proxy retry needs to actually authenticate.
 */
export function maskProxyCredentials(url: string): string {
	return url.replace(/(:\/\/[^:/@\s]+):[^@\s]*@/, "$1:***@");
}

/**
 * Every proxy/TLS-relevant environment variable that is actually set, in the
 * user's own spelling.
 *
 * `readProxyEnv` deliberately normalizes to a fixed set of fields, which is
 * what the logic needs — but it hides everything else, including
 * `NODE_EXTRA_CA_CERTS` (the remedy our own TLS guidance hands out) and npm's
 * `npm_config_*` overrides. On a machine where the network misbehaves, the
 * variable nobody thought to look at is usually the one causing it, so report
 * whatever is there rather than only what we modelled.
 */
const REPORTED_ENV_VARS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
	"NODE_USE_SYSTEM_CA",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"NODE_OPTIONS",
	"npm_config_proxy",
	"npm_config_https_proxy",
	"npm_config_registry",
	"npm_config_strict_ssl",
	"npm_config_cafile",
] as const;

export function setProxyEnvVars(
	env: NodeJS.ProcessEnv = process.env,
): Array<{ name: string; value: string }> {
	const out: Array<{ name: string; value: string }> = [];
	for (const name of REPORTED_ENV_VARS) {
		const value = nonEmpty(env[name]);
		if (value !== null) out.push({ name, value: maskProxyCredentials(value) });
	}
	return out;
}

/**
 * The proxy that applies to a given URL, or null when none does — accounting
 * for the scheme, for NO_PROXY, and for whether Node was actually told to use
 * a proxy at all.
 */
export function proxyForUrl(
	url: string,
	proxy: ProxyEnv = readProxyEnv(),
): string | null {
	if (!proxy.useEnvProxy) return null;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (matchingNoProxyEntry(proxy, parsed.hostname)) return null;
	const chosen =
		parsed.protocol === "https:"
			? (proxy.httpsProxy ?? proxy.httpProxy)
			: (proxy.httpProxy ?? proxy.httpsProxy);
	return chosen ? maskProxyCredentials(chosen) : null;
}

/** The host CoDev's backend, SSO wrapper and skill hub all live on. */
export function backendHost(): string {
	try {
		return new URL(BACKEND_URL).hostname;
	} catch {
		return "";
	}
}

// Standard NO_PROXY matching: comma-separated entries, `*` means everything, a
// leading dot or `*.` is a suffix match, an optional `:port` suffix is ignored
// for our purposes (we only ever talk https).
export function noProxyEntryMatches(entry: string, host: string): boolean {
	const clean = entry.trim().toLowerCase().replace(/:\d+$/, "");
	if (!clean) return false;
	if (clean === "*") return true;
	const target = host.toLowerCase();
	if (clean.startsWith("*.")) return target.endsWith(clean.slice(1));
	if (clean.startsWith(".")) return target.endsWith(clean);
	return target === clean || target.endsWith(`.${clean}`);
}

/**
 * The NO_PROXY entry that would exempt `host` from the proxy, or null.
 *
 * This is the documented cause of the "Login failed" symptom in the install
 * guide: internal images ship with `*.viettel.vn` in NO_PROXY, which sends our
 * backend traffic direct — straight into the firewall — while every other
 * request correctly goes through the proxy.
 */
export function matchingNoProxyEntry(
	proxy: ProxyEnv,
	host: string,
): string | null {
	if (!proxy.noProxy || !host) return null;
	for (const entry of proxy.noProxy.split(",")) {
		if (noProxyEntryMatches(entry, host)) return entry.trim();
	}
	return null;
}

/** NO_PROXY with every entry that would exempt `host` removed. */
export function stripNoProxyFor(noProxy: string, host: string): string {
	return noProxy
		.split(",")
		.filter((entry) => entry.trim() && !noProxyEntryMatches(entry, host))
		.map((entry) => entry.trim())
		.join(",");
}

export type ProxyAction =
	// No HTTP_PROXY/HTTPS_PROXY set — nothing to do.
	| "none"
	// Already active: the user set NODE_USE_ENV_PROXY themselves, or we are the
	// re-exec child.
	| "already-active"
	// Enabled in-process via http.setGlobalProxyFromEnv().
	| "applied"
	// Re-executed with NODE_USE_ENV_PROXY=1; the caller must exit.
	| "reexec"
	// We tried and could not enable it. Non-fatal: the command proceeds and
	// fails with a diagnosable network error rather than a mystery.
	| "failed";

// True once we enabled proxying ourselves, as opposed to the user having set
// NODE_USE_ENV_PROXY. The distinction only matters for advice: proxying works
// either way for *this* process, but npm and the agents are separate processes
// and still need the variable set in the user's shell.
let autoEnabled = false;

export function proxyAutoEnabled(): boolean {
	return autoEnabled;
}

/** Test-only: forget that we enabled the proxy so each case starts clean. */
export function resetProxyState(): void {
	autoEnabled = false;
}

export interface ProxyResult {
	action: ProxyAction;
	exitCode?: number;
	/** Set when NO_PROXY would send backend traffic direct. */
	noProxyWarning?: string;
	error?: string;
}

/**
 * Make `fetch` honor HTTP_PROXY/HTTPS_PROXY for this process.
 *
 * Called from index.tsx right after initLogging and before command dispatch.
 * Strictly best-effort: any failure returns "failed" and the command runs
 * anyway — a proxy we couldn't enable must not stop `codevhub doctor` from
 * running and explaining why the network is broken.
 */
export function applyEnvProxy(): ProxyResult {
	const proxy = readProxyEnv();

	// A NO_PROXY exemption for our own backend defeats the proxy no matter how
	// it is enabled, so surface it on every path below (including "none", where
	// the user has no proxy but may still have inherited the entry).
	const noProxyEntry = matchingNoProxyEntry(proxy, backendHost());
	const noProxyWarning = noProxyEntry
		? `NO_PROXY contains "${noProxyEntry}", which sends ${backendHost()} traffic ` +
			"direct instead of through your proxy. This is the usual cause of " +
			"`Login failed`. Remove that entry and re-run."
		: undefined;

	if (!hasProxyConfigured(proxy)) return { action: "none", noProxyWarning };
	if (proxy.useEnvProxy || isEnabled(process.env[PROXY_APPLIED_ENV])) {
		return { action: "already-active", noProxyWarning };
	}

	// Fast path: enable it in-process. Verified to route global `fetch`, not
	// just node:http/https Agent traffic.
	if (httpApi.supported()) {
		try {
			httpApi.setGlobalProxyFromEnv();
			// Record the truth in the environment. Two reasons this matters:
			//   1. Everything downstream reads NODE_USE_ENV_PROXY to decide whether
			//      the proxy is live. Leaving it unset made diagnoseError claim
			//      "Node is IGNORING your proxy settings" on a request that had
			//      demonstrably just gone through the proxy — a message that
			//      contradicts its own evidence is worse than no message.
			//   2. Children we spawn (npm, the agents) inherit it, so they pick up
			//      the proxy too instead of each needing their own fix.
			process.env.NODE_USE_ENV_PROXY = "1";
			autoEnabled = true;
			logInfo("enabled proxy from environment", {
				action: "proxy.configure",
				extra: {
					via: "setGlobalProxyFromEnv",
					no_proxy_conflict: !!noProxyEntry,
				},
			});
			return { action: "applied", noProxyWarning };
		} catch (err) {
			logWarn("setGlobalProxyFromEnv failed; falling back to re-exec", {
				action: "proxy.configure",
				err,
			});
		}
	}

	return { ...reexecWithEnvProxy(), noProxyWarning };
}

// Slow path for Node builds without setGlobalProxyFromEnv: relaunch ourselves
// with NODE_USE_ENV_PROXY=1 so the flag is present at bootstrap, where Node
// actually reads it. stdio is inherited, so the user sees one continuous
// session; we just exit with the child's code.
function reexecWithEnvProxy(): ProxyResult {
	const selfPath = process.argv[1];
	if (!selfPath) {
		const error = "cannot determine CLI entry path for proxy re-exec";
		logWarn(error, { action: "proxy.configure", outcome: "failure" });
		return { action: "failed", error };
	}

	logInfo("re-executing with NODE_USE_ENV_PROXY=1", {
		action: "proxy.configure",
		extra: { via: "reexec" },
	});
	// Ink owns the TTY once a command renders, but this runs before dispatch, so
	// plain stderr is safe here and the extra process isn't a mystery.
	process.stderr.write(
		"Detected HTTP_PROXY; restarting with NODE_USE_ENV_PROXY=1 so it takes effect.\n",
	);

	const traceId = currentTraceId();
	const result = spawner.spawnSync(
		process.execPath,
		[...process.execArgv, selfPath, ...process.argv.slice(2)],
		{
			stdio: "inherit",
			env: {
				...process.env,
				NODE_USE_ENV_PROXY: "1",
				[PROXY_APPLIED_ENV]: "1",
				...(traceId ? { CODEV_TRACE_PARENT: traceId } : {}),
			},
		},
	);
	return { action: "reexec", exitCode: result.status ?? 1 };
}
