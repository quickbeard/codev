import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	currentTraceId,
	initLogging,
	logDebug,
	logError,
	logFileName,
	logInfo,
	pruneLogs,
	resetLogging,
} from "@/lib/log.js";

let tempDir: string;
let logDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-log-"));
	logDir = join(tempDir, "diag");
	vi.stubEnv("CODEV_LOG_DIR", logDir);
});

afterEach(() => {
	resetLogging();
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function readDocs(): Record<string, unknown>[] {
	const path = join(logDir, logFileName(new Date()));
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function rawLog(): string {
	const path = join(logDir, logFileName(new Date()));
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

describe("initLogging", () => {
	test("writes an ECS command.start document", () => {
		initLogging("upload", ["--daemon"], { installProcessHooks: false });
		const docs = readDocs();
		expect(docs).toHaveLength(1);
		const doc = docs[0] as {
			"@timestamp": string;
			ecs?: { version?: string };
			log?: { level?: string };
			service?: { name?: string; version?: string };
			process?: { pid?: number };
			trace?: { id?: string };
			codev?: { command?: string; args?: string[] };
			event?: { action?: string };
		};
		expect(typeof doc["@timestamp"]).toBe("string");
		expect(Number.isNaN(Date.parse(doc["@timestamp"]))).toBe(false);
		expect(doc.ecs?.version).toBeTruthy();
		expect(doc.log?.level).toBe("info");
		expect(doc.service?.name).toBe("codev");
		expect(typeof doc.service?.version).toBe("string");
		expect(doc.process?.pid).toBe(process.pid);
		expect(typeof doc.trace?.id).toBe("string");
		expect(doc.codev?.command).toBe("upload");
		expect(doc.event?.action).toBe("command.start");
		expect(doc.codev?.args).toEqual(["--daemon"]);
	});

	test("is idempotent — the first command wins and the trace id is stable", () => {
		initLogging("upload", [], { installProcessHooks: false });
		const trace = currentTraceId();
		initLogging("install", [], { installProcessHooks: false });
		logInfo("after second init");
		const docs = readDocs();
		expect(docs.length).toBe(2);
		for (const doc of docs) {
			expect((doc.codev as { command?: string }).command).toBe("upload");
			expect((doc.trace as { id?: string }).id).toBe(trace);
		}
	});

	test("CODEV_LOG_LEVEL=silent disables logging entirely", () => {
		vi.stubEnv("CODEV_LOG_LEVEL", "silent");
		initLogging("upload", [], { installProcessHooks: false });
		logError("should not be written");
		expect(existsSync(logDir)).toBe(false);
		expect(currentTraceId()).toBeNull();
	});

	test("CODEV_TRACE_PARENT lands in codev.parent_trace_id", () => {
		vi.stubEnv("CODEV_TRACE_PARENT", "parent-trace-123");
		initLogging("upload", [], { installProcessHooks: false });
		const doc = readDocs()[0] as { codev?: { parent_trace_id?: string } };
		expect(doc.codev?.parent_trace_id).toBe("parent-trace-123");
	});

	test("degrades to no-op when the log dir cannot be created", () => {
		const blocker = join(tempDir, "blocker");
		writeFileSync(blocker, "i am a file");
		vi.stubEnv("CODEV_LOG_DIR", join(blocker, "nested"));
		expect(() => {
			initLogging("upload", [], { installProcessHooks: false });
			logInfo("into the void");
		}).not.toThrow();
		expect(currentTraceId()).toBeNull();
	});

	test("installs process hooks by default and resetLogging removes them", () => {
		const before = {
			exit: process.listeners("exit").length,
			uncaught: process.listeners("uncaughtException").length,
			unhandled: process.listeners("unhandledRejection").length,
		};
		initLogging("upload", []);
		expect(process.listeners("exit").length).toBe(before.exit + 1);
		expect(process.listeners("uncaughtException").length).toBe(
			before.uncaught + 1,
		);
		expect(process.listeners("unhandledRejection").length).toBe(
			before.unhandled + 1,
		);
		resetLogging();
		expect(process.listeners("exit").length).toBe(before.exit);
		expect(process.listeners("uncaughtException").length).toBe(before.uncaught);
		expect(process.listeners("unhandledRejection").length).toBe(
			before.unhandled,
		);
	});
});

describe("log levels", () => {
	test("each helper writes its level", () => {
		initLogging("upload", [], { installProcessHooks: false });
		logDebug("d");
		logInfo("i");
		logError("e");
		const levels = readDocs().map((d) => (d.log as { level: string }).level);
		expect(levels).toEqual(["info", "debug", "info", "error"]);
	});

	test("CODEV_LOG_LEVEL=warn suppresses debug and info", () => {
		vi.stubEnv("CODEV_LOG_LEVEL", "warn");
		initLogging("upload", [], { installProcessHooks: false });
		logDebug("d");
		logInfo("i");
		logError("e");
		const levels = readDocs().map((d) => (d.log as { level: string }).level);
		// command.start is info-level, so it is filtered too.
		expect(levels).toEqual(["error"]);
	});
});

describe("field mapping", () => {
	test("maps err to ECS error.*", () => {
		initLogging("upload", [], { installProcessHooks: false });
		logError("boom", { err: new Error("presign-upload failed (401)") });
		const doc = readDocs().at(-1) as {
			error?: { message?: string; type?: string; stack_trace?: string };
		};
		expect(doc.error?.message).toBe("presign-upload failed (401)");
		expect(doc.error?.type).toBe("Error");
		expect(doc.error?.stack_trace).toContain("Error");
	});

	test("maps url/method/status/duration to ECS fields with query stripped", () => {
		initLogging("upload", [], { installProcessHooks: false });
		logInfo("http", {
			action: "http.request",
			outcome: "failure",
			url: "https://api.example.com/functions/v1/presign-upload?token=SECRETTOK",
			method: "POST",
			status: 401,
			durationMs: 12,
		});
		const doc = readDocs().at(-1) as {
			url?: { domain?: string; path?: string };
			http?: {
				request?: { method?: string };
				response?: { status_code?: number };
			};
			event?: { action?: string; outcome?: string; duration?: number };
		};
		expect(doc.url?.domain).toBe("api.example.com");
		expect(doc.url?.path).toBe("/functions/v1/presign-upload");
		expect(doc.http?.request?.method).toBe("POST");
		expect(doc.http?.response?.status_code).toBe(401);
		expect(doc.event?.action).toBe("http.request");
		expect(doc.event?.outcome).toBe("failure");
		expect(doc.event?.duration).toBe(12_000_000);
		expect(rawLog()).not.toContain("SECRETTOK");
	});

	test("extra fields land under codev.*", () => {
		initLogging("upload", [], { installProcessHooks: false });
		logInfo("ctx", { extra: { endpoint: "supabase.presign", attempt: 2 } });
		const doc = readDocs().at(-1) as {
			codev?: { endpoint?: string; attempt?: number };
		};
		expect(doc.codev?.endpoint).toBe("supabase.presign");
		expect(doc.codev?.attempt).toBe(2);
	});
});

describe("redaction", () => {
	test("redacts secret-looking keys in extra, including nested objects", () => {
		initLogging("upload", [], { installProcessHooks: false });
		logInfo("creds", {
			extra: {
				api_key: "super-secret-key-value",
				nested: { authorization: "also-secret-value", safe: "visible" },
			},
		});
		const raw = rawLog();
		expect(raw).not.toContain("super-secret-key-value");
		expect(raw).not.toContain("also-secret-value");
		expect(raw).toContain("[REDACTED]");
		expect(raw).toContain("visible");
	});

	test("scrubs bearer tokens, JWTs, gateway keys, and secret query params from any text", () => {
		initLogging("upload", [], { installProcessHooks: false });
		logError(
			"auth failed: Bearer abc123tokenvalue rejected; " +
				"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl expired",
			{
				err: new Error(
					"presign rejected key sk-litellm0gateway0key at " +
						"https://x.example/cb?code=AUTHCODE99&state=STATE77",
				),
			},
		);
		const raw = rawLog();
		expect(raw).not.toContain("abc123tokenvalue");
		expect(raw).not.toContain("eyJzdWIiOiJ1c2VyIn0");
		expect(raw).not.toContain("sk-litellm0gateway0key");
		expect(raw).not.toContain("AUTHCODE99");
		expect(raw).not.toContain("STATE77");
		expect(raw).toContain("Bearer [REDACTED]");
		expect(raw).toContain("[REDACTED:jwt]");
		expect(raw).toContain("[REDACTED:key]");
	});
});

describe("pruneLogs", () => {
	test("deletes files older than maxAgeDays, keyed on the filename date", () => {
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, "codev-20260520.ndjson"), "{}\n");
		writeFileSync(join(logDir, "codev-20260601.ndjson"), "{}\n");
		pruneLogs(logDir, { maxAgeDays: 14 }, new Date(Date.UTC(2026, 5, 10)));
		expect(existsSync(join(logDir, "codev-20260520.ndjson"))).toBe(false);
		expect(existsSync(join(logDir, "codev-20260601.ndjson"))).toBe(true);
	});

	test("deletes oldest-first down to the size budget", () => {
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, "codev-20260601.ndjson"), "12345678\n");
		writeFileSync(join(logDir, "codev-20260602.ndjson"), "12345678\n");
		pruneLogs(
			logDir,
			{ maxAgeDays: 9999, maxTotalBytes: 10 },
			new Date(Date.UTC(2026, 5, 10)),
		);
		expect(existsSync(join(logDir, "codev-20260601.ndjson"))).toBe(false);
		expect(existsSync(join(logDir, "codev-20260602.ndjson"))).toBe(true);
	});

	test("never touches files or folders outside the codev-YYYYMMDD.ndjson pattern", () => {
		mkdirSync(join(logDir, "works-myapp"), { recursive: true });
		writeFileSync(join(logDir, "notes.txt"), "keep me");
		writeFileSync(join(logDir, "codev-19990101.ndjson"), "{}\n");
		pruneLogs(logDir, { maxAgeDays: 1 }, new Date(Date.UTC(2026, 5, 10)));
		expect(existsSync(join(logDir, "works-myapp"))).toBe(true);
		expect(existsSync(join(logDir, "notes.txt"))).toBe(true);
		expect(existsSync(join(logDir, "codev-19990101.ndjson"))).toBe(false);
		expect(readdirSync(logDir).sort()).toEqual(["notes.txt", "works-myapp"]);
	});

	test("is a no-op on a missing directory", () => {
		expect(() => pruneLogs(join(tempDir, "absent"))).not.toThrow();
	});
});
