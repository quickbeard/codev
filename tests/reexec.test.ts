import type * as childProcess from "node:child_process";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ensureNodeSqliteOrReexec, spawner } from "@/lib/reexec.js";

// `bun test` runs under Bun, which doesn't expose node:sqlite. That makes
// the failure paths of ensureNodeSqliteOrReexec() trivially reachable here:
// the initial `import("node:sqlite")` always throws, so the function falls
// through to the re-exec/error logic and we can assert on it.
//
// If Bun ever ships node:sqlite, the probe at the top of each test will see
// the import succeed and skip the failure-path assertions. The Node-runtime
// "ok" path is covered end-to-end by tests/providers/opencode.node.test.ts.
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
	expect(args).toContain("--no-warnings=ExperimentalWarning");
	expect(args).toContain("/path/to/dist/index.js");
	expect(args).toContain("upload");
});
