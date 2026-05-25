import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runAgent, spawner } from "@/lib/run.js";

let tempDir: string;
let errorSpy: MockInstance;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-run-test-"));
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	errorSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runAgent", () => {
	test("returns 0 when child exits cleanly", async () => {
		expect(await runAgent("node", ["-e", ""])).toBe(0);
	});

	test("returns the child's non-zero exit code", async () => {
		expect(await runAgent("node", ["-e", "process.exit(7)"])).toBe(7);
	});

	test("forwards args verbatim to the child", async () => {
		const outPath = join(tempDir, "argv.json");
		const script = `require('fs').writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(process.argv.slice(1)))`;
		const code = await runAgent("node", [
			"-e",
			script,
			"hello",
			"--flag",
			"world",
		]);
		expect(code).toBe(0);
		const captured = JSON.parse(readFileSync(outPath, "utf-8"));
		expect(captured).toEqual(["hello", "--flag", "world"]);
	});

	test("returns 1 and prints install hint on ENOENT", async () => {
		const code = await runAgent("codev-nonexistent-binary-xyzzy-12345", []);
		expect(code).toBe(1);
		const messages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			messages.some((m: string) =>
				m.includes(
					"could not be launched. If it isn't installed, run 'codev install'",
				),
			),
		).toBe(true);
	});

	test("maps signal death to 128 + signo", async () => {
		const code = await runAgent("node", [
			"-e",
			"process.kill(process.pid, 'SIGTERM')",
		]);
		expect(code).toBe(128 + constants.signals.SIGTERM);
	});

	test("prints a startup banner to stderr before launching", async () => {
		// vi.spyOn(process.stderr, 'write') doesn't reliably intercept under
		// vitest's stdio handling, so swap the method directly. stdio:'inherit'
		// wires the child to the parent's stderr fd, not through this method,
		// so we only capture our own banner write.
		const original = process.stderr.write.bind(process.stderr);
		const calls: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			calls.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			await runAgent("node", ["-e", ""]);
		} finally {
			process.stderr.write = original;
		}
		// Unknown commands fall back to the bare cmd as their label.
		expect(calls.some((m) => m.includes("Starting node..."))).toBe(true);
	});

	test("uses the friendly product label for known agents", async () => {
		// Stub spawn so we don't launch a real `claude` binary on dev machines
		// that have Claude Code installed — its stdin handshake would otherwise
		// hang the test for ~3s (and intermittently exceed the 5s timeout under
		// full-suite parallelism). The banner write fires before spawn, so
		// returning a fake child that immediately emits `exit(0)` is enough.
		const fakeChild = new EventEmitter() as unknown as ChildProcess;
		const spawnSpy = vi.spyOn(spawner, "spawn").mockImplementation(((
			..._args: unknown[]
		) => {
			queueMicrotask(() => fakeChild.emit("exit", 0, null));
			return fakeChild;
		}) as unknown as typeof spawner.spawn);

		const original = process.stderr.write.bind(process.stderr);
		const calls: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			calls.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			await runAgent("claude", []);
		} finally {
			process.stderr.write = original;
			spawnSpy.mockRestore();
		}
		expect(calls.some((m) => m.includes("Starting Claude Code..."))).toBe(true);
	});
});
