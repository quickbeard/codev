import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Update } from "@/components/Update.js";

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

// `cleanup()` from ink-testing-library can take >10 s on a heavily-loaded
// Windows CI runner (vitest's default hookTimeout). Bumping the hook to 30 s
// covers the worst-case observed (~19 s wall-clock); genuine hangs still
// surface.
afterEach(() => {
	cleanup();
}, 30_000);

describe("Update", () => {
	test("renders 'Checking installed agents...' during detection", async () => {
		// Never-resolving npm root keeps detection pending.
		stubExecFile(() => ({ stdout: "" }));
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const { frames } = render(<Update onDone={() => {}} />);
		await new Promise((r) => setTimeout(r, 10));
		expect(allFrames(frames)).toContain("Checking installed agents");
	});

	test("calls onDone(true) with a 'nothing to update' message when no agents detected", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await new Promise((r) => setTimeout(r, 80));

		expect(allFrames(frames)).toContain("nothing to update");
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("updates only tools detected under npm global root", async () => {
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "npm" && args[0] === "install") return { stdout: "ok" };
			if (file === "opencode") return { stdout: "1.0.0" };
			return { stdout: "" };
		});
		// Only opencode's package dir exists.
		const existsSpy = vi
			.mocked(fs.existsSync)
			.mockImplementation(
				(p: fs.PathLike) => String(p) === join("/fake/root", "opencode-ai"),
			);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain("opencode-ai");
		expect(history).not.toContain("@anthropic-ai/claude-code");
		expect(history).toContain("Updated opencode-ai");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("reports update failure and calls onDone(false)", async () => {
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
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain("Failed to update opencode-ai");
		expect(history).toContain("permission denied");
		expect(onDone).toHaveBeenCalledWith(false);
		existsSpy.mockRestore();
	});
});
