import type * as childProcess from "node:child_process";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ensureNodeSqliteOrReexec, spawner } from "@/lib/reexec.js";

async function nodeSqliteAvailable(): Promise<boolean> {
	try {
		await import("node:sqlite");
		return true;
	} catch {
		return false;
	}
}

let spawnSyncSpy: MockInstance;
let originalArgv: string[];
let originalExecArgv: string[];

beforeEach(() => {
	originalArgv = process.argv;
	originalExecArgv = process.execArgv;
	spawnSyncSpy = vi.spyOn(spawner, "spawnSync");
});

afterEach(() => {
	process.argv = originalArgv;
	process.execArgv = originalExecArgv;
	spawnSyncSpy.mockRestore();
});

test("returns error when already re-execed but node:sqlite still missing", async () => {
	if (await nodeSqliteAvailable()) return;
	process.execArgv = [
		"--experimental-sqlite",
		...originalExecArgv.filter((a) => a !== "--experimental-sqlite"),
	];
	const result = await ensureNodeSqliteOrReexec();
	expect(result.action).toBe("error");
	expect(result.error).toContain("node:sqlite");
});

test("returns error when CLI entry path is missing", async () => {
	if (await nodeSqliteAvailable()) return;
	process.execArgv = originalExecArgv.filter(
		(a) => a !== "--experimental-sqlite",
	);
	process.argv = [process.argv[0] ?? "node"];
	const result = await ensureNodeSqliteOrReexec();
	expect(result.action).toBe("error");
	expect(result.error).toContain("entry path");
});

test("re-execs with --experimental-sqlite when node:sqlite is unloadable", async () => {
	if (await nodeSqliteAvailable()) return;
	process.execArgv = originalExecArgv.filter(
		(a) => a !== "--experimental-sqlite",
	);
	process.argv = [
		process.argv[0] ?? "node",
		"/path/to/dist/index.js",
		"upload",
	];
	spawnSyncSpy.mockImplementation(
		() =>
			({
				status: 0,
				signal: null,
				output: [],
				pid: 0,
				stdout: Buffer.alloc(0),
				stderr: Buffer.alloc(0),
			}) as unknown as ReturnType<typeof childProcess.spawnSync>,
	);
	const result = await ensureNodeSqliteOrReexec();
	expect(result.action).toBe("reexec");
	expect(result.exitCode).toBe(0);
	const call = spawnSyncSpy.mock.calls[0];
	const args = call?.[1] as string[] | undefined;
	expect(args?.[0]).toBe("--experimental-sqlite");
	expect(args).toContain("--disable-warning=ExperimentalWarning");
	expect(args).toContain("/path/to/dist/index.js");
	expect(args).toContain("upload");
});

test("suppresses node:sqlite ExperimentalWarning emitted during the probe", async () => {
	if (!(await nodeSqliteAvailable())) return;
	await ensureNodeSqliteOrReexec();

	const stderrSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(() => true);
	try {
		process.emitWarning("SQLite is an experimental feature codev-test-marker", {
			type: "ExperimentalWarning",
		});
		process.emitWarning("a different non-sqlite warning codev-test-marker");
		await new Promise((resolve) => setImmediate(resolve));
		const stderr = stderrSpy.mock.calls.flat().map(String).join("");
		expect(stderr).not.toMatch(/SQLite is an experimental feature/);
		expect(stderr).toMatch(/non-sqlite warning codev-test-marker/);
	} finally {
		stderrSpy.mockRestore();
	}
});
