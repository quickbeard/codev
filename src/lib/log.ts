import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { VERSION } from "@/lib/const.js";
import { cliLogsDir } from "@/lib/paths.js";
import { applySystemCaCertsOnce, isCertError } from "@/lib/tls.js";

// Runs a request, and if it fails because the certificate chain isn't trusted,
// merges the OS trust store into Node's defaults and tries once more.
//
// Node ignores the OS store, so a user behind a TLS-intercepting proxy fails
// every request while their browser works (see lib/tls.ts). Recovering *here*,
// on the failure, rather than merging up-front, is what keeps the cost off the
// happy path: the OS-store read is synchronous and blocks the event loop for
// ~300ms on Windows, which is enough to stall Ink's render timers.
//
// At most one retry per process: applySystemCaCertsOnce returns null once it has
// run, so a chain that stays untrusted surfaces its error instead of looping.
// Safe to replay — a TLS handshake fails before any body is sent, and every
// call site passes a replayable body (string/URLSearchParams/FormData/Buffer),
// never a stream.
async function fetchTrustingSystemCa(
	input: string | URL,
	init: RequestInit | undefined,
	endpoint: string,
): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (err) {
		if (!isCertError(err)) throw err;
		const ca = applySystemCaCertsOnce();
		if (ca?.status !== "merged") throw err;
		logInfo("certificate chain untrusted; retrying with the OS CA store", {
			action: "http.request",
			extra: { endpoint, ca_system_count: ca.systemCount },
		});
		return await fetch(input, init);
	}
}

// CoDev's local diagnostic log: one Elastic-Common-Schema NDJSON document per
// line, written to ~/.codev-hub/logs/codev-YYYYMMDD.ndjson (UTC date). The files
// are plain ECS, so a Filebeat/Elastic Agent filestream input can ingest them
// unmodified if logs are ever collected centrally — but nothing here ships
// anything; the CLI only appends locally.
//
// Ground rules, in priority order:
//   1. Logging can never break or block a command — every disk touch is
//      wrapped, and a failed init degrades to no-op.
//   2. No secrets on disk — key-based redaction before serialization plus
//      pattern scrubbing of the serialized line (tokens, JWTs, gateway keys,
//      OAuth/signed-URL query params).
//   3. Never write to stdout/stderr — codev is an interactive Ink CLI and a
//      stray write would corrupt the TTY frame.
//
// Multi-process safety: the foreground CLI and the detached upload daemon can
// log concurrently. Each event is a single O_APPEND write to a date-named
// file — no shared fd, no rename-based rotation (a rename under a live writer
// loses lines on Windows). Retention is by deletion only (pruneLogs).

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const ECS_VERSION = "8.11";

// Retention defaults: prune by age first (the date is in the filename, so the
// cutoff is deterministic — no mtime games), then oldest-first down to the
// size budget.
const MAX_AGE_DAYS = 14;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface LogFields {
	// event.action — keep to the stable taxonomy: command.start, command.end,
	// http.request, process.spawn, process.exit, step.transition, task.result,
	// export.provider, upload.file, upload.summary, daemon.skip, daemon.run,
	// configure.tool, configure.api-key, configure.smoke-test, model.fallback,
	// restore.kind, sqlite.probe, crash.
	action?: string;
	// ECS event.type — distinguishes a begin document ("start") from its
	// completion ("end") without forking event.action. Start documents are the
	// evidence trail when an operation hangs and never completes.
	eventType?: "start" | "end";
	outcome?: "success" | "failure";
	durationMs?: number;
	// Anything Error-shaped; mapped to ECS error.message/type/stack_trace.
	err?: unknown;
	// Full URL; persisted as url.domain + url.path with the query stripped.
	url?: string;
	method?: string;
	status?: number;
	// Extra context, persisted under the codev.* namespace after key-based
	// redaction.
	extra?: Record<string, unknown>;
	// Verbatim fields that bypass BOTH redaction layers — the field-key redactor
	// (redactByKey) AND the serialized-line scrubber (scrubLine). The ONLY
	// sanctioned use is the gateway API key we intentionally record at
	// install/config time (see logApiKeyConfigured); everything else must use
	// `extra`, which stays fully redacted.
	unsafeUnredacted?: Record<string, unknown>;
}

interface LoggingState {
	enabled: boolean;
	level: LogLevel;
	dir: string;
	command: string;
	traceId: string;
	parentTraceId: string | null;
	startedAt: number;
	onExit: ((code: number) => void) | null;
	onUncaught: ((err: unknown) => void) | null;
	onUnhandled: ((reason: unknown) => void) | null;
}

let state: LoggingState | null = null;

export interface InitLoggingOptions {
	// Tests pass false so vitest's own process stays free of our exit/crash
	// listeners; resetLogging() removes whatever was installed.
	installProcessHooks?: boolean;
}

// Idempotent — the first caller (index.tsx, before command dispatch) wins.
// CODEV_LOG_LEVEL=silent disables logging entirely; CODEV_LOG_DIR overrides
// the destination (used by tests). CODEV_TRACE_PARENT carries the spawning
// process's trace id across re-exec and daemon boundaries so one user action
// can be followed through every process it fans into.
export function initLogging(
	command: string,
	argv: string[],
	opts: InitLoggingOptions = {},
): void {
	if (state) return;
	const levelEnv = process.env.CODEV_LOG_LEVEL?.toLowerCase();
	const silent = levelEnv === "silent";
	const level: LogLevel =
		levelEnv && levelEnv in LEVEL_RANK ? (levelEnv as LogLevel) : "debug";
	state = {
		enabled: !silent,
		level,
		dir: process.env.CODEV_LOG_DIR || cliLogsDir(),
		command,
		traceId: randomUUID(),
		parentTraceId: process.env.CODEV_TRACE_PARENT || null,
		startedAt: Date.now(),
		onExit: null,
		onUncaught: null,
		onUnhandled: null,
	};
	if (!state.enabled) return;
	try {
		mkdirSync(state.dir, { recursive: true, mode: 0o700 });
	} catch {
		state.enabled = false;
		return;
	}
	pruneLogs(state.dir);

	if (opts.installProcessHooks !== false) {
		const startedAt = state.startedAt;
		state.onExit = (code: number) => {
			writeDoc(code === 0 ? "info" : "warn", `command exited (code ${code})`, {
				action: "command.end",
				outcome: code === 0 ? "success" : "failure",
				durationMs: Date.now() - startedAt,
				extra: { exit_code: code },
			});
		};
		// Replicate Node's default crash behavior (print to stderr, exit 1) on
		// top of capturing a structured `crash` doc — installing a listener
		// suppresses the default handler, so we must do its job ourselves.
		state.onUncaught = (err: unknown) => {
			writeDoc("error", "uncaught exception", { action: "crash", err });
			console.error(err instanceof Error ? (err.stack ?? err.message) : err);
			process.exit(1);
		};
		state.onUnhandled = (reason: unknown) => {
			writeDoc("error", "unhandled promise rejection", {
				action: "crash",
				err: reason,
			});
			console.error(
				reason instanceof Error ? (reason.stack ?? reason.message) : reason,
			);
			process.exit(1);
		};
		process.on("exit", state.onExit);
		process.on("uncaughtException", state.onUncaught);
		process.on("unhandledRejection", state.onUnhandled);
	}

	writeDoc("info", `codevhub ${command} started`, {
		action: "command.start",
		extra: {
			args: argv,
			node: process.versions.node,
			arch: process.arch,
		},
	});
}

// Test hook: removes installed process listeners and clears the singleton so
// each test can re-init against its own CODEV_LOG_DIR.
export function resetLogging(): void {
	if (state) {
		if (state.onExit) process.off("exit", state.onExit);
		if (state.onUncaught) process.off("uncaughtException", state.onUncaught);
		if (state.onUnhandled) process.off("unhandledRejection", state.onUnhandled);
	}
	state = null;
}

// The active trace id, for propagation to child codev processes via the
// CODEV_TRACE_PARENT env var (re-exec, upload daemon). Null when logging is
// disabled or uninitialized.
export function currentTraceId(): string | null {
	return state?.enabled ? state.traceId : null;
}

export function logDebug(message: string, fields: LogFields = {}): void {
	writeDoc("debug", message, fields);
}

export function logInfo(message: string, fields: LogFields = {}): void {
	writeDoc("info", message, fields);
}

export function logWarn(message: string, fields: LogFields = {}): void {
	writeDoc("warn", message, fields);
}

export function logError(message: string, fields: LogFields = {}): void {
	writeDoc("error", message, fields);
}

// The ONLY sanctioned use of unsafeUnredacted: record the gateway API key the
// user configured during `codevhub install`/`codevhub config`, in cleartext, so a
// misconfigured key is diagnosable. Scoped to those commands by its call sites
// in SetupApp — `codevhub model` also persists keys (saveApiKey) but deliberately
// does not log them. The key lands in codev.api_key, NOT the message, so
// `codevhub logs` shows only the headline line, never the secret. base_url/model
// are non-secret and ride along in `extra` (still redacted by key like anything
// else, though neither matches the secret-key pattern).
export function logApiKeyConfigured(
	source: "new" | "existing" | "manual",
	apiKey: string,
	baseUrl?: string,
	model?: string,
): void {
	logInfo("configured gateway API key", {
		action: "configure.api-key",
		extra: { source, base_url: baseUrl, model },
		unsafeUnredacted: { api_key: apiKey },
	});
}

const ERROR_BODY_MAX_CHARS = 2048;

// Read an error response's body from a CLONE so the caller's own
// res.text()/res.json() still sees the original stream untouched.
async function errorBody(res: Response): Promise<string> {
	try {
		if (typeof res.clone !== "function") return "";
		const text = await res.clone().text();
		return text.length > ERROR_BODY_MAX_CHARS
			? `${text.slice(0, ERROR_BODY_MAX_CHARS)}…[truncated]`
			: text;
	} catch {
		return "";
	}
}

// Instrumented fetch for codev's direct network calls (SSO, backend,
// gateway, Supabase). `endpoint` is a stable label (e.g. "backend.config",
// "supabase.presign") persisted as codev.endpoint so failures group cleanly.
//
// Writes a start document (the evidence trail when a request hangs and never
// completes), then a completion document with status + duration — success at
// debug, non-2xx at warn (the caller decides whether that status is fatal and
// throws its own error), thrown fetch errors (network/timeout/abort) at error
// before rethrowing. Request headers and bodies are never logged — they carry
// bearer tokens; error response bodies are captured from a clone, truncated,
// and pass through the same line scrubbing as every other document. With
// logging disabled this is a plain fetch passthrough.
export async function loggedFetch(
	endpoint: string,
	input: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const url = String(input);
	const method = init?.method ?? "GET";
	logDebug(`http ${method} ${endpoint}`, {
		action: "http.request",
		eventType: "start",
		url,
		method,
		extra: { endpoint },
	});
	const startedAt = Date.now();
	try {
		const res = await fetchTrustingSystemCa(input, init, endpoint);
		const durationMs = Date.now() - startedAt;
		if (res.ok) {
			logDebug(`http ${method} ${endpoint} → ${res.status}`, {
				action: "http.request",
				eventType: "end",
				outcome: "success",
				url,
				method,
				status: res.status,
				durationMs,
				extra: { endpoint },
			});
		} else {
			// Only pay for the body clone when the document will be written.
			const body = state?.enabled ? await errorBody(res) : "";
			logWarn(`http ${method} ${endpoint} → ${res.status}`, {
				action: "http.request",
				eventType: "end",
				outcome: "failure",
				url,
				method,
				status: res.status,
				durationMs,
				extra: { endpoint, response_body: body },
			});
		}
		return res;
	} catch (err) {
		logError(`http ${method} ${endpoint} failed`, {
			action: "http.request",
			eventType: "end",
			outcome: "failure",
			url,
			method,
			durationMs: Date.now() - startedAt,
			err,
			extra: { endpoint },
		});
		throw err;
	}
}

export function logFileName(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const y = date.getUTCFullYear();
	const m = pad(date.getUTCMonth() + 1);
	const d = pad(date.getUTCDate());
	return `codev-${y}${m}${d}.ndjson`;
}

function writeDoc(level: LogLevel, message: string, fields: LogFields): void {
	if (!state?.enabled) return;
	if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;
	try {
		const doc = buildDoc(state, level, message, fields);
		const serialized = JSON.stringify(doc);
		// A doc carrying unsafeUnredacted content opts out of the line scrubber
		// too — the value (a gateway API key) would otherwise be caught by the
		// sk-…/JWT/Bearer patterns. Only logApiKeyConfigured sets this.
		const line = fields.unsafeUnredacted ? serialized : scrubLine(serialized);
		appendFileSync(join(state.dir, logFileName(new Date())), `${line}\n`);
	} catch {
		// Rule 1: logging never breaks the CLI.
	}
}

function buildDoc(
	s: LoggingState,
	level: LogLevel,
	message: string,
	f: LogFields,
): Record<string, unknown> {
	const codev: Record<string, unknown> = {
		command: s.command,
		...redactByKey(f.extra ?? {}),
		// Verbatim, bypassing redactByKey — see LogFields.unsafeUnredacted. The
		// serialized-line scrubber is skipped for this doc in writeDoc.
		...(f.unsafeUnredacted ?? {}),
	};
	if (s.parentTraceId) codev.parent_trace_id = s.parentTraceId;

	const doc: Record<string, unknown> = {
		"@timestamp": new Date().toISOString(),
		ecs: { version: ECS_VERSION },
		log: { level },
		message,
		service: { name: "codev", version: VERSION },
		process: { pid: process.pid },
		host: { os: { platform: process.platform } },
		trace: { id: s.traceId },
		codev,
	};

	const event: Record<string, unknown> = {};
	if (f.action) event.action = f.action;
	if (f.eventType) event.type = [f.eventType];
	if (f.outcome) event.outcome = f.outcome;
	// ECS event.duration is nanoseconds.
	if (f.durationMs !== undefined) {
		event.duration = Math.round(f.durationMs * 1e6);
	}
	if (Object.keys(event).length > 0) doc.event = event;

	if (f.url) doc.url = urlFields(f.url);
	if (f.method || f.status !== undefined) {
		const http: Record<string, unknown> = {};
		if (f.method) http.request = { method: f.method };
		if (f.status !== undefined) http.response = { status_code: f.status };
		doc.http = http;
	}
	if (f.err !== undefined) doc.error = errorFields(f.err);
	return doc;
}

// Persist domain + path only. Query strings carry OAuth codes, signed-URL
// signatures, and API keys — they never reach the document at all (the line
// scrubber below is the backstop, not the primary defense).
function urlFields(raw: string): Record<string, unknown> {
	try {
		const u = new URL(raw);
		return { domain: u.hostname, path: u.pathname };
	} catch {
		const q = raw.indexOf("?");
		return { original: q === -1 ? raw : raw.slice(0, q) };
	}
}

function errorFields(err: unknown): Record<string, unknown> {
	if (err instanceof Error) {
		const out: Record<string, unknown> = {
			message: err.message,
			type: err.name,
		};
		if (err.stack) out.stack_trace = err.stack;
		return out;
	}
	return { message: String(err), type: "unknown" };
}

const SECRET_KEY_RE =
	/(token|secret|password|authorization|api.?key|anon.?key|credential|cookie)/i;

// First redaction layer: any extra field whose KEY looks secret-bearing is
// replaced wholesale, recursively through plain nested objects.
function redactByKey(extra: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(extra)) {
		if (SECRET_KEY_RE.test(key)) {
			out[key] = "[REDACTED]";
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			out[key] = redactByKey(value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out;
}

// Second redaction layer, applied to the fully serialized line: VALUE shapes
// that must never reach disk regardless of which field carried them. Bearer
// credentials, JWT-shaped tokens (SSO/Supabase), LiteLLM gateway keys, and
// sensitive query params (OAuth code/state, signed-URL signatures).
const SCRUB_PATTERNS: [RegExp, string][] = [
	[/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
	[/eyJ[\w-]{4,}\.[\w-]{4,}(?:\.[\w-]+)?/g, "[REDACTED:jwt]"],
	[/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED:key]"],
	[
		/([?&](?:code|state|token|apikey|api_key|access_token|refresh_token|id_token|signature|sig|x-amz-[a-z-]+)=)[^&"\\\s]+/gi,
		"$1[REDACTED]",
	],
];

function scrubLine(line: string): string {
	let out = line;
	for (const [re, replacement] of SCRUB_PATTERNS) {
		out = out.replace(re, replacement);
	}
	return out;
}

export interface PruneLimits {
	maxAgeDays?: number;
	maxTotalBytes?: number;
}

function parseFileDate(name: string): Date | null {
	const m = name.match(/^codev-(\d{4})(\d{2})(\d{2})\.ndjson$/);
	if (!m) return null;
	const [, y, mo, d] = m;
	return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

// Retention sweep, run once at init. Only files matching our own
// codev-YYYYMMDD.ndjson pattern are ever touched — the directory can contain
// legacy conversation-export folders the export migration hasn't moved yet,
// and those must survive untouched.
export function pruneLogs(
	dir: string,
	limits: PruneLimits = {},
	now: Date = new Date(),
): void {
	const maxAgeDays = limits.maxAgeDays ?? MAX_AGE_DAYS;
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
	try {
		// Filename sort is chronological for the fixed YYYYMMDD format.
		const files = readdirSync(dir)
			.filter((name) => parseFileDate(name) !== null)
			.sort();

		const survivors: { name: string; size: number }[] = [];
		for (const name of files) {
			const fileDate = parseFileDate(name);
			const ageMs = fileDate ? now.getTime() - fileDate.getTime() : 0;
			if (ageMs > maxAgeDays * 86_400_000) {
				try {
					unlinkSync(join(dir, name));
					continue;
				} catch {
					// Treat as surviving so the size pass can retry the delete.
				}
			}
			let size = 0;
			try {
				size = statSync(join(dir, name)).size;
			} catch {
				continue;
			}
			survivors.push({ name, size });
		}

		let total = survivors.reduce((sum, f) => sum + f.size, 0);
		for (const f of survivors) {
			if (total <= maxTotalBytes) break;
			try {
				unlinkSync(join(dir, f.name));
				total -= f.size;
			} catch {
				// Best-effort.
			}
		}
	} catch {
		// Best-effort.
	}
}
