import * as child_process from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CONTINUE_EXTENSION_ID,
	installContinueExtension,
	isCodeCliAvailable,
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

function stubExecFile(opts: StubOptions): ExecCall[] {
	const calls: ExecCall[] = [];
	vi.mocked(child_process.execFile).mockImplementation(((
		file: string,
		args: string[],
		...rest: unknown[]
	) => {
		calls.push({ file, args });
		const cb = rest[rest.length - 1] as ExecCb;
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
	test("invokes `code --install-extension continue.continue --force`", async () => {
		const calls = stubExecFile({ handler: () => ({}) });
		const err = await installContinueExtension();

		expect(err).toBeNull();
		expect(calls).toEqual([
			{
				file: "code",
				args: ["--install-extension", CONTINUE_EXTENSION_ID, "--force"],
			},
		]);
	});

	test("returns null silently when `code` is not on PATH (ENOENT)", async () => {
		// ENOENT == VSCode CLI not installed or not on PATH. That's a soft fail:
		// the install proceeds, the YAML config is still written, and Configure's
		// resume hint nudges the user to run the extension install manually.
		const enoent = Object.assign(new Error("spawn code ENOENT"), {
			code: "ENOENT",
		}) as NodeJS.ErrnoException;
		stubExecFile({ handler: () => ({ error: enoent }) });
		const err = await installContinueExtension();
		expect(err).toBeNull();
	});

	test("surfaces non-ENOENT errors so the install task fails visibly", async () => {
		// Non-ENOENT errno: a real `code` invocation that returned non-zero
		// (marketplace down, network failure, …) — `code` field is left unset.
		const fail: NodeJS.ErrnoException = new Error("nope");
		stubExecFile({
			handler: () => ({ error: fail, stderr: "marketplace unreachable" }),
		});
		const err = await installContinueExtension();
		expect(err).toBe("marketplace unreachable");
	});
});

describe("isCodeCliAvailable", () => {
	test("returns true when `code --version` succeeds", async () => {
		stubExecFile({ handler: () => ({ stdout: "1.96.0\n" }) });
		expect(await isCodeCliAvailable()).toBe(true);
	});

	test("returns false when `code` is missing (ENOENT)", async () => {
		const enoent = Object.assign(new Error("spawn code ENOENT"), {
			code: "ENOENT",
		}) as NodeJS.ErrnoException;
		stubExecFile({ handler: () => ({ error: enoent }) });
		expect(await isCodeCliAvailable()).toBe(false);
	});
});
