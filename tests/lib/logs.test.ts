import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runLogs } from "@/lib/logs.js";

let tempDir: string;
let logDir: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-logs-cmd-"));
	logDir = join(tempDir, "diag");
	mkdirSync(logDir, { recursive: true });
	vi.stubEnv("CODEV_LOG_DIR", logDir);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	logSpy.mockRestore();
	errorSpy.mockRestore();
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function output(): string {
	return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

function errors(): string {
	return errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

interface DocOpts {
	ts?: string;
	level?: string;
	command?: string;
	parent?: string;
	errMessage?: string;
	codevExtra?: Record<string, unknown>;
	version?: string;
}

function doc(traceId: string, message: string, opts: DocOpts = {}): string {
	return JSON.stringify({
		"@timestamp": opts.ts ?? "2026-06-11T08:00:00.000Z",
		log: { level: opts.level ?? "info" },
		message,
		...(opts.version
			? { service: { name: "codev", version: opts.version } }
			: {}),
		trace: { id: traceId },
		codev: {
			command: opts.command ?? "upload",
			...(opts.parent ? { parent_trace_id: opts.parent } : {}),
			...(opts.codevExtra ?? {}),
		},
		...(opts.errMessage ? { error: { message: opts.errMessage } } : {}),
	});
}

function writeLogFile(name: string, lines: string[]): void {
	writeFileSync(join(logDir, name), `${lines.join("\n")}\n`);
}

describe("codev logs (bare)", () => {
	test("prints the most recent run, skipping prior `codev logs` invocations", () => {
		writeLogFile("codev-20260610.ndjson", [
			doc("trace-old", "codev install started", { command: "install" }),
		]);
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-upload", "codev upload started"),
			doc("trace-upload", "upload failed", {
				level: "error",
				errMessage: "presign-upload failed (401): denied",
			}),
			doc("trace-viewer", "codev logs started", { command: "logs" }),
		]);

		expect(runLogs([])).toBe(0);
		const out = output();
		expect(out).toContain("Run trace-upload — codev upload");
		expect(out).toContain("INFO  codev upload started");
		expect(out).toContain("ERROR upload failed");
		expect(out).toContain("↳ presign-upload failed (401): denied");
		expect(out).not.toContain("trace-viewer");
		expect(out).not.toContain("codev install started");
	});

	test("includes the codev version in the run header when present", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-ver", "codev upload started", { version: "0.3.8" }),
		]);

		expect(runLogs([])).toBe(0);
		expect(output()).toContain("Run trace-ver — codev upload v0.3.8 —");
	});

	test("omits the version tag when no document carries one", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-nover", "codev upload started"),
		]);

		expect(runLogs([])).toBe(0);
		const out = output();
		expect(out).toContain("Run trace-nover — codev upload —");
		expect(out).not.toContain("codev upload v");
	});

	test("prefers the top-level run over its later-writing child and lists the child", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-agent", "codev claude started", { command: "claude" }),
			doc("trace-daemon", "auto-upload skipped: not logged in", {
				parent: "trace-agent",
			}),
		]);

		expect(runLogs([])).toBe(0);
		const out = output();
		expect(out).toContain("Run trace-agent — codev claude");
		expect(out).toContain(
			"Child run trace-daemon — view with: codev logs --trace trace-daemon",
		);
	});

	test("falls back to a child run when no top-level run exists", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-daemon", "auto-upload skipped: not logged in", {
				parent: "trace-pruned-away",
			}),
		]);

		expect(runLogs([])).toBe(0);
		expect(output()).toContain("Run trace-daemon — codev upload");
	});

	test("skips malformed lines instead of failing", () => {
		writeLogFile("codev-20260611.ndjson", [
			"{not json at all",
			doc("trace-ok", "codev update started", { command: "update" }),
		]);

		expect(runLogs([])).toBe(0);
		expect(output()).toContain("Run trace-ok — codev update");
	});

	test("errors when only `codev logs` runs are recorded", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-viewer", "codev logs started", { command: "logs" }),
		]);
		expect(runLogs([])).toBe(1);
		expect(errors()).toContain("No prior runs recorded.");
	});

	test("errors when the directory has no log files", () => {
		expect(runLogs([])).toBe(1);
		expect(errors()).toContain(`No diagnostic logs found in ${logDir}.`);
	});
});

describe("codev logs --path", () => {
	test("prints the newest log file path", () => {
		writeLogFile("codev-20260610.ndjson", [doc("a", "older")]);
		writeLogFile("codev-20260611.ndjson", [doc("b", "newer")]);
		expect(runLogs(["--path"])).toBe(0);
		expect(output().trim()).toBe(join(logDir, "codev-20260611.ndjson"));
	});
});

describe("codev logs --trace", () => {
	test("prints one run by trace id prefix, across files", () => {
		writeLogFile("codev-20260610.ndjson", [
			doc("aaaa-1111", "codev model started", { command: "model" }),
		]);
		writeLogFile("codev-20260611.ndjson", [
			doc("bbbb-2222", "codev upload started"),
		]);

		expect(runLogs(["--trace", "aaaa"])).toBe(0);
		const out = output();
		expect(out).toContain("Run aaaa-1111 — codev model");
		expect(out).not.toContain("bbbb-2222");
	});

	test("rejects an ambiguous prefix and lists the candidates", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("aaaa-1111", "one"),
			doc("aaaa-2222", "two"),
		]);
		expect(runLogs(["--trace", "aaaa"])).toBe(1);
		const err = errors();
		expect(err).toContain("ambiguous");
		expect(err).toContain("aaaa-1111");
		expect(err).toContain("aaaa-2222");
	});

	test("errors when no documents match", () => {
		writeLogFile("codev-20260611.ndjson", [doc("aaaa-1111", "one")]);
		expect(runLogs(["--trace", "zzzz"])).toBe(1);
		expect(errors()).toContain("No documents for trace zzzz.");
	});

	test("requires a value", () => {
		writeLogFile("codev-20260611.ndjson", [doc("aaaa-1111", "one")]);
		expect(runLogs(["--trace"])).toBe(1);
		expect(errors()).toContain("--trace requires a trace id");
	});
});

describe("codev logs argument handling", () => {
	test("rejects unknown options with usage", () => {
		expect(runLogs(["--nope"])).toBe(1);
		const err = errors();
		expect(err).toContain("Unknown option: --nope");
		expect(err).toContain("Usage: codev logs");
	});
});

describe("codev logs --verbose", () => {
	test("surfaces codev.* context (api_key, source, model) as ↳ lines", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-cfg", "codev config started", { command: "config" }),
			doc("trace-cfg", "configured gateway API key", {
				command: "config",
				codevExtra: { source: "new", model: "gpt-5", api_key: "sk-realkey123" },
			}),
		]);
		expect(runLogs(["--verbose"])).toBe(0);
		const out = output();
		expect(out).toContain("configured gateway API key");
		expect(out).toContain("↳ api_key=sk-realkey123");
		expect(out).toContain("↳ source=new");
		expect(out).toContain("↳ model=gpt-5");
		// Structural fields (command, parent_trace_id) aren't repeated as detail.
		expect(out).not.toContain("↳ command=");
	});

	test("the compact (non-verbose) view hides codev.api_key", () => {
		// Legitimate negative: the same data renders the key in the --verbose
		// branch above — this pins the conditional, not a removed feature.
		writeLogFile("codev-20260611.ndjson", [
			doc("trace-cfg", "configured gateway API key", {
				command: "config",
				codevExtra: { api_key: "sk-secretkey789" },
			}),
		]);
		expect(runLogs([])).toBe(0);
		expect(output()).not.toContain("sk-secretkey789");
	});

	test("composes with --trace", () => {
		writeLogFile("codev-20260611.ndjson", [
			doc("aaaa-1111", "configured gateway API key", {
				command: "config",
				codevExtra: { api_key: "sk-tracekey456" },
			}),
		]);
		expect(runLogs(["--trace", "aaaa", "--verbose"])).toBe(0);
		expect(output()).toContain("↳ api_key=sk-tracekey456");
	});
});
