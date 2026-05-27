import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { UpdateApp } from "@/UpdateApp.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

// Normalize execFile call shapes: production code uses (file, args, opts, cb)
// on POSIX and the single-string (cmdString, opts, cb) form on Windows (to
// avoid Node 22's DEP0190). The handler always gets (file, args).
function stubExecFile(
	handler: (
		file: string,
		args: string[],
	) => { error?: Error | null; stdout?: string; stderr?: string },
) {
	vi.mocked(child_process.execFile).mockImplementation(((
		...callArgs: unknown[]
	) => {
		const cb = callArgs[callArgs.length - 1] as ExecCb;
		const first = callArgs[0] as string;
		const second = callArgs[1];
		let file: string;
		let args: string[];
		if (Array.isArray(second)) {
			file = first;
			args = second as string[];
		} else {
			const tokens = first.split(/\s+/).filter(Boolean);
			file = tokens[0] ?? "";
			args = tokens.slice(1);
		}
		const r = handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
}

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

// Windows CI is 2-3× slower than Linux/macOS and vi.waitFor's default ~1s
// timeout isn't enough for the full UpdateApp render pipeline (detect →
// updating → TaskList settle → parent setPhase → render Happy coding).
// 10s matches the slack we give Ink renders elsewhere (see tests/
// InstallApp.test.tsx#waitForFrame).
const WAIT_OPTS = { timeout: 10_000, interval: 50 } as const;

afterEach(() => {
	cleanup();
});

describe("UpdateApp", () => {
	test("shows 'Happy coding' after a successful update", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "npm" && args[0] === "install") return { stdout: "ok" };
			if (file === "opencode") return { stdout: "1.0.0" };
			return { stdout: "" };
		});
		const existsSpy = vi
			.mocked(fs.existsSync)
			.mockImplementation(
				(p: fs.PathLike) => String(p) === join("/fake/root", "opencode-ai"),
			);

		const { frames } = render(<UpdateApp />);
		await vi.waitFor(
			() => expect(allFrames(frames)).toContain("Happy coding"),
			WAIT_OPTS,
		);

		const history = allFrames(frames);
		expect(history).toContain("Updated opencode-ai");
		expect(history).toContain("Happy coding");
		existsSpy.mockRestore();
	});

	test("shows 'Happy coding' even when there is nothing to update", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);

		const { frames } = render(<UpdateApp />);
		await vi.waitFor(
			() => expect(allFrames(frames)).toContain("Happy coding"),
			WAIT_OPTS,
		);

		const history = allFrames(frames);
		expect(history).toContain("Nothing to update");
		expect(history).toContain("Happy coding");
		existsSpy.mockRestore();
	});

	test("does NOT show 'Happy coding' when an update fails", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "npm" && args[0] === "install") {
				return { error: new Error("x"), stderr: "permission denied" };
			}
			return { stdout: "" };
		});
		const existsSpy = vi
			.mocked(fs.existsSync)
			.mockImplementation(
				(p: fs.PathLike) => String(p) === join("/fake/root", "opencode-ai"),
			);

		const { frames } = render(<UpdateApp />);
		await vi.waitFor(
			() => expect(allFrames(frames)).toContain("Failed to update opencode-ai"),
			WAIT_OPTS,
		);

		const history = allFrames(frames);
		expect(history).toContain("Failed to update opencode-ai");
		expect(history).not.toContain("Happy coding");
		existsSpy.mockRestore();
	});
});
