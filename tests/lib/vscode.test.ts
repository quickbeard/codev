import * as child_process from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CLAUDE_CODE_EXTENSION_ID,
	CONTINUE_EXTENSION_ID,
	installClaudeCodeExtension,
	installContinueExtension,
} from "@/lib/vscode.js";

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

// Normalize execFile call shapes: production code uses `(file, args, opts,
// cb)` on POSIX and the single-string `(cmdString, opts, cb)` form on Windows
// (the latter to avoid Node 22's DEP0190 — passing args with shell:true is
// deprecated). Tests assert on (file, args) regardless of platform.
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("installContinueExtension", () => {
	test("invokes `code --install-extension continue.continue --force` and resolves null on success", async () => {
		const calls = stubExecFile({ handler: () => ({}) });
		const result = await installContinueExtension();

		expect(result).toBeNull();
		expect(calls).toEqual([
			{
				file: "code",
				args: ["--install-extension", CONTINUE_EXTENSION_ID, "--force"],
			},
		]);
	});

	test("returns a soft warning when `code` is not on PATH (ENOENT)", async () => {
		// ENOENT == VS Code CLI not installed or not on PATH. With option B,
		// this is a soft fail: the install flow advances, the YAML config is
		// still written, and Configure surfaces the warning as a manual-install
		// hint. The warning text mentions `code` so the user knows what to fix.
		const enoent = Object.assign(new Error("spawn code ENOENT"), {
			code: "ENOENT",
		}) as NodeJS.ErrnoException;
		stubExecFile({ handler: () => ({ error: enoent }) });
		const result = await installContinueExtension();
		expect(result).toEqual({ warning: "VS Code launcher not found on PATH" });
	});

	test("returns a soft warning on non-ENOENT failures (proxy / marketplace / etc.)", async () => {
		// A real `code` invocation that returned non-zero. With option B this
		// is no longer a hard failure — it rides forward as a warning the
		// Configure step can surface, instead of aborting `codevhub install`.
		const fail: NodeJS.ErrnoException = new Error("nope");
		stubExecFile({
			handler: () => ({ error: fail, stderr: "marketplace unreachable" }),
		});
		const result = await installContinueExtension();
		expect(result).toEqual({ warning: "marketplace unreachable" });
	});

	test("falls back to error message when stderr is empty", async () => {
		const fail: NodeJS.ErrnoException = new Error("ECONNRESET");
		stubExecFile({ handler: () => ({ error: fail, stderr: "" }) });
		const result = await installContinueExtension();
		expect(result).toEqual({ warning: "ECONNRESET" });
	});
});

describe("installClaudeCodeExtension", () => {
	test("invokes `code --install-extension anthropic.claude-code --force` and resolves null on success", async () => {
		// Mirror of the Continue test — confirms the wrapper passes the
		// Claude Code marketplace id to the shared installExtension helper.
		const calls = stubExecFile({ handler: () => ({}) });
		const result = await installClaudeCodeExtension();

		expect(result).toBeNull();
		expect(calls).toEqual([
			{
				file: "code",
				args: ["--install-extension", CLAUDE_CODE_EXTENSION_ID, "--force"],
			},
		]);
	});

	test("returns a soft warning when `code` is not on PATH (ENOENT)", async () => {
		const enoent = Object.assign(new Error("spawn code ENOENT"), {
			code: "ENOENT",
		}) as NodeJS.ErrnoException;
		stubExecFile({ handler: () => ({ error: enoent }) });
		const result = await installClaudeCodeExtension();
		expect(result).toEqual({ warning: "VS Code launcher not found on PATH" });
	});

	test("returns a soft warning on non-ENOENT failures", async () => {
		const fail: NodeJS.ErrnoException = new Error("nope");
		stubExecFile({
			handler: () => ({ error: fail, stderr: "marketplace unreachable" }),
		});
		const result = await installClaudeCodeExtension();
		expect(result).toEqual({ warning: "marketplace unreachable" });
	});
});
