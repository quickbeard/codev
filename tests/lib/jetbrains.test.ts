import * as child_process from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CONTINUE_INTELLIJ_PLUGIN_ID,
	installContinuePlugin,
	JETBRAINS_CLIS,
} from "@/lib/jetbrains.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

type ExecCb = (
	error: NodeJS.ErrnoException | null,
	stdout: string,
	stderr: string,
) => void;

interface ExecCall {
	file: string;
	args: string[];
}

interface StubOptions {
	handler: (
		file: string,
		args: string[],
	) => {
		error?: NodeJS.ErrnoException | null;
		stdout?: string;
		stderr?: string;
	};
}

// Mirror of the helper in vscode.test.ts / npm.test.ts — production code on
// win32 calls `execFile(cmdString, opts, cb)` (shell:true to dodge DEP0190);
// tests normalize back to `(file, args)` regardless of platform.
function normalizeExecFileCall(callArgs: unknown[]): {
	file: string;
	args: string[];
	cb: ExecCb;
} {
	const cb = callArgs[callArgs.length - 1] as ExecCb;
	const first = callArgs[0] as string;
	const second = callArgs[1];
	if (Array.isArray(second)) {
		return { file: first, args: second as string[], cb };
	}
	const tokens = first.split(/\s+/).filter(Boolean);
	return { file: tokens[0] ?? "", args: tokens.slice(1), cb };
}

function stubExecFile(opts: StubOptions): ExecCall[] {
	const calls: ExecCall[] = [];
	vi.mocked(child_process.execFile).mockImplementation(((
		...callArgs: unknown[]
	) => {
		const { file, args, cb } = normalizeExecFileCall(callArgs);
		calls.push({ file, args });
		const r = opts.handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
	return calls;
}

const enoent = (bin: string): NodeJS.ErrnoException =>
	Object.assign(new Error(`spawn ${bin} ENOENT`), {
		code: "ENOENT",
	}) as NodeJS.ErrnoException;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("installContinuePlugin", () => {
	test("invokes each JetBrains CLI on PATH with `installPlugins <id>`", async () => {
		// Only `idea` is on PATH; pycharm + goland return ENOENT and are
		// counted as "user doesn't have that IDE", not failures.
		const calls = stubExecFile({
			handler: (file) =>
				file === "idea" ? { stdout: "ok" } : { error: enoent(file) },
		});
		const result = await installContinuePlugin();

		expect(result).toBeNull();
		// Every CLI is probed in order, exactly once.
		expect(calls.map((c) => c.file)).toEqual([...JETBRAINS_CLIS]);
		for (const c of calls) {
			expect(c.args).toEqual(["installPlugins", CONTINUE_INTELLIJ_PLUGIN_ID]);
		}
	});

	test("installs on every CLI on PATH (multi-IDE host)", async () => {
		// User has IntelliJ + GoLand; PyCharm not installed.
		stubExecFile({
			handler: (file) =>
				file === "pycharm" ? { error: enoent(file) } : { stdout: "ok" },
		});
		const result = await installContinuePlugin();
		expect(result).toBeNull();
	});

	test("returns a soft warning when no JetBrains CLI is on PATH", async () => {
		// Toolbox without "Generate shell scripts" enabled — none of the
		// launchers resolve. Soft fail; the YAML config still gets written
		// and Configure surfaces the manual-install hint.
		stubExecFile({ handler: (file) => ({ error: enoent(file) }) });
		const result = await installContinuePlugin();
		expect(result).toEqual({
			warning:
				"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
		});
	});

	test("aggregates non-ENOENT failures into a single warning", async () => {
		// pycharm is on PATH but the install returns non-zero (e.g. marketplace
		// down). idea + goland aren't installed (ENOENT). The aggregated
		// warning names each failing CLI so the user knows which IDEs to
		// retry manually.
		stubExecFile({
			handler: (file) => {
				if (file === "pycharm") {
					return {
						error: new Error("exit 1") as NodeJS.ErrnoException,
						stderr: "marketplace 503",
					};
				}
				return { error: enoent(file) };
			},
		});
		const result = await installContinuePlugin();
		expect(result).toEqual({ warning: "pycharm: marketplace 503" });
	});

	test("notes partial success when one CLI succeeds and another fails", async () => {
		// idea installs cleanly; goland is on PATH but the install fails.
		// We still want the user to know goland needs manual attention.
		stubExecFile({
			handler: (file) => {
				if (file === "idea") return { stdout: "ok" };
				if (file === "goland") {
					return {
						error: new Error("exit 1") as NodeJS.ErrnoException,
						stderr: "auth required",
					};
				}
				return { error: enoent(file) };
			},
		});
		const result = await installContinuePlugin();
		expect(result).toEqual({
			warning:
				"installed for some IDEs but failed for others — goland: auth required",
		});
	});

	test("falls back to error message when stderr is empty on a hard fail", async () => {
		stubExecFile({
			handler: (file) => {
				if (file === "idea") {
					return {
						error: new Error("ECONNRESET") as NodeJS.ErrnoException,
						stderr: "",
					};
				}
				return { error: enoent(file) };
			},
		});
		const result = await installContinuePlugin();
		expect(result).toEqual({ warning: "idea: ECONNRESET" });
	});
});
