import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { logTaskResult } from "@/components/TaskList.js";
import {
	currentTraceId,
	initLogging,
	logApiKeyConfigured,
	logDebug,
	logError,
	logFileName,
	loggedFetch,
	logInfo,
	pruneLogs,
	resetLogging,
} from "@/lib/log.js";
import { execAsync } from "@/lib/npm.js";
import { runAgent, spawner as runSpawner } from "@/lib/run.js";

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

describe("logApiKeyConfigured (unsafeUnredacted)", () => {
	test("records the gateway API key verbatim, past both redaction layers", () => {
		initLogging("install", [], { installProcessHooks: false });
		logApiKeyConfigured("new", "sk-litellm0realkey0value", undefined, "gpt-5");
		// The sk-… value would normally be scrubbed to [REDACTED:key], and a
		// field literally named api_key would be [REDACTED] by key — the unsafe
		// hatch keeps it cleartext on disk.
		expect(rawLog()).toContain("sk-litellm0realkey0value");
		const doc = readDocs().find(
			(d) => (d.event as { action?: string })?.action === "configure.api-key",
		) as {
			codev?: { api_key?: string; source?: string; model?: string };
			message?: string;
		};
		expect(doc.codev?.api_key).toBe("sk-litellm0realkey0value");
		expect(doc.codev?.source).toBe("new");
		expect(doc.codev?.model).toBe("gpt-5");
		// The key rides in codev.api_key, never the message, so `codevhub logs`'
		// pretty printer (message-only) never echoes it to the terminal.
		expect(doc.message).toBe("configured gateway API key");
	});

	test("bypass is per-document — other docs stay redacted", () => {
		initLogging("install", [], { installProcessHooks: false });
		logApiKeyConfigured(
			"manual",
			"sk-keptcleartextvalue",
			"https://gw.example",
		);
		logInfo("creds", { extra: { api_key: "sk-should0be0redacted" } });
		const raw = rawLog();
		expect(raw).toContain("sk-keptcleartextvalue");
		expect(raw).not.toContain("sk-should0be0redacted");
		expect(raw).toContain("[REDACTED");
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

describe("loggedFetch", () => {
	test("passes through and writes start + completion documents", async () => {
		initLogging("upload", [], { installProcessHooks: false });
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("ok", { status: 200 }));
		try {
			const res = await loggedFetch(
				"backend.config",
				"https://proxy.example.com/codev-backend/config?x=1",
				{
					method: "POST",
					headers: { Authorization: "Bearer topsecrettokenvalue" },
				},
			);
			expect(await res.text()).toBe("ok");

			const docs = readDocs();
			const start = docs.at(-2) as {
				log?: { level?: string };
				event?: { action?: string; type?: string[] };
				codev?: { endpoint?: string };
				url?: { domain?: string; path?: string };
			};
			const end = docs.at(-1) as {
				event?: {
					action?: string;
					type?: string[];
					outcome?: string;
					duration?: number;
				};
				http?: {
					request?: { method?: string };
					response?: { status_code?: number };
				};
				codev?: { endpoint?: string };
			};
			expect(start.event?.action).toBe("http.request");
			expect(start.event?.type).toEqual(["start"]);
			expect(start.codev?.endpoint).toBe("backend.config");
			expect(start.url?.domain).toBe("proxy.example.com");
			expect(start.url?.path).toBe("/codev-backend/config");
			expect(end.event?.type).toEqual(["end"]);
			expect(end.event?.outcome).toBe("success");
			expect(end.http?.request?.method).toBe("POST");
			expect(end.http?.response?.status_code).toBe(200);
			expect(typeof end.event?.duration).toBe("number");
			// Request headers are never serialized — the bearer value must not
			// appear anywhere in the file.
			expect(rawLog()).not.toContain("topsecrettokenvalue");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("logs non-2xx at warn with a scrubbed body and leaves the caller's stream readable", async () => {
		initLogging("upload", [], { installProcessHooks: false });
		const body = `denied: jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln expired. ${"x".repeat(3000)}`;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(body, { status: 401 }));
		try {
			const res = await loggedFetch(
				"supabase.presign",
				"https://s.example.com/functions/v1/presign-upload",
			);
			expect(res.status).toBe(401);
			// The logged clone must not consume the caller's body.
			expect(await res.text()).toBe(body);

			const end = readDocs().at(-1) as {
				log?: { level?: string };
				event?: { outcome?: string };
				http?: { response?: { status_code?: number } };
				codev?: { response_body?: string };
			};
			expect(end.log?.level).toBe("warn");
			expect(end.event?.outcome).toBe("failure");
			expect(end.http?.response?.status_code).toBe(401);
			expect(end.codev?.response_body).toContain("[REDACTED:jwt]");
			expect(end.codev?.response_body).toContain("…[truncated]");
			expect(rawLog()).not.toContain("eyJzdWIiOiJ1c2VyIn0");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("logs thrown fetch errors at error level and rethrows", async () => {
		initLogging("upload", [], { installProcessHooks: false });
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new TypeError("fetch failed"));
		try {
			await expect(
				loggedFetch("sso.token", "https://sso.example.com/token", {
					method: "POST",
				}),
			).rejects.toThrow("fetch failed");

			const end = readDocs().at(-1) as {
				log?: { level?: string };
				event?: { outcome?: string };
				error?: { message?: string; type?: string };
			};
			expect(end.log?.level).toBe("error");
			expect(end.event?.outcome).toBe("failure");
			expect(end.error?.message).toBe("fetch failed");
			expect(end.error?.type).toBe("TypeError");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("is a plain fetch passthrough when logging is uninitialized", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("nope", { status: 500 }));
		try {
			const res = await loggedFetch(
				"gateway.models",
				"https://gw.example.com/v1/models",
			);
			expect(res.status).toBe(500);
			expect(await res.text()).toBe("nope");
			expect(existsSync(logDir)).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("execAsync logging", () => {
	test("writes spawn and exit documents, with exit code and stderr tail on failure", async () => {
		initLogging("install", [], { installProcessHooks: false });
		const ok = await execAsync(process.execPath, ["-e", "process.exit(0)"]);
		expect(ok.error).toBeNull();
		const fail = await execAsync(process.execPath, [
			"-e",
			"process.stderr.write('boom-marker');process.exit(3)",
		]);
		expect(fail.error).not.toBeNull();

		const docs = readDocs();
		const starts = docs.filter(
			(d) => (d.event as { action?: string })?.action === "process.spawn",
		);
		expect(starts).toHaveLength(2);
		const exits = docs.filter(
			(d) => (d.event as { action?: string })?.action === "process.exit",
		) as {
			log?: { level?: string };
			event?: { outcome?: string; duration?: number };
			codev?: { exit_code?: unknown; stderr_tail?: string };
		}[];
		expect(exits).toHaveLength(2);
		expect(exits[0]?.event?.outcome).toBe("success");
		expect(exits[1]?.event?.outcome).toBe("failure");
		expect(exits[1]?.log?.level).toBe("warn");
		expect(exits[1]?.codev?.exit_code).toBe(3);
		expect(exits[1]?.codev?.stderr_tail).toContain("boom-marker");
		expect(typeof exits[1]?.event?.duration).toBe("number");
	});
});

describe("runAgent logging", () => {
	test("logs launch and exit without recording agent arg contents", async () => {
		initLogging("codex", [], { installProcessHooks: false });
		const fakeChild = new EventEmitter() as unknown as ChildProcess;
		const spawnSpy = vi.spyOn(runSpawner, "spawn").mockImplementation((() => {
			queueMicrotask(() =>
				(fakeChild as unknown as EventEmitter).emit("exit", 2, null),
			);
			return fakeChild;
		}) as never);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			// Use codex: a non-zero `claude` exit additionally probes the native
			// binary via a real `npm root -g`, which would interleave its own
			// process documents into the assertion window.
			const code = await runAgent("codex", ["-p", "SECRET-PROMPT-MARKER"]);
			expect(code).toBe(2);

			const docs = readDocs();
			const spawn = docs.find(
				(d) => (d.event as { action?: string })?.action === "process.spawn",
			) as { codev?: { agent?: string; args_count?: number } };
			expect(spawn?.codev?.agent).toBe("codex");
			expect(spawn?.codev?.args_count).toBe(2);
			const exit = docs.find(
				(d) => (d.event as { action?: string })?.action === "process.exit",
			) as {
				log?: { level?: string };
				event?: { outcome?: string };
				codev?: { exit_code?: number };
			};
			expect(exit?.event?.outcome).toBe("failure");
			expect(exit?.log?.level).toBe("warn");
			expect(exit?.codev?.exit_code).toBe(2);
			// Agent args can carry prompt text — contents must never reach disk.
			expect(rawLog()).not.toContain("SECRET-PROMPT-MARKER");
		} finally {
			spawnSpy.mockRestore();
			stderrSpy.mockRestore();
		}
	});
});

describe("logTaskResult", () => {
	test("levels and outcomes mirror the task row state", () => {
		initLogging("install", [], { installProcessHooks: false });
		logTaskResult("a", "pkg-a", null);
		logTaskResult("b", "pkg-b", "exploded");
		logTaskResult("c", "pkg-c", { warning: "soft trouble" });

		const docs = readDocs().filter(
			(d) => (d.event as { action?: string })?.action === "task.result",
		) as {
			log?: { level?: string };
			event?: { outcome?: string };
			codev?: { key?: string; error?: string; warning?: string };
		}[];
		expect(docs).toHaveLength(3);
		expect(docs[0]?.log?.level).toBe("info");
		expect(docs[0]?.event?.outcome).toBe("success");
		expect(docs[1]?.log?.level).toBe("error");
		expect(docs[1]?.event?.outcome).toBe("failure");
		expect(docs[1]?.codev?.error).toBe("exploded");
		expect(docs[2]?.log?.level).toBe("warn");
		expect(docs[2]?.codev?.warning).toBe("soft trouble");
	});
});
