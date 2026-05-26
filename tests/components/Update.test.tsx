import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Update } from "@/components/Update.js";
import * as configure from "@/lib/configure.js";

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

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// Helper: stub `detectConfiguredTools` to claim Continue is configured.
// By default the file-system probe inside detectConfiguredTools would walk
// real ~/.continue/config.yaml; mocking keeps tests hermetic and avoids
// the developer's actual config bleeding through.
function stubContinueDetected(detected: boolean) {
	vi.spyOn(configure, "detectConfiguredTools").mockReturnValue(
		detected ? ["vscode-continue"] : [],
	);
}

// Same idea, but for the Claude Code marker. The Update flow probes the
// same IDE launchers for both extensions, so each test pins exactly one
// marker to keep the assertions narrow.
function stubClaudeCodeDetected(detected: boolean) {
	vi.spyOn(configure, "detectConfiguredTools").mockReturnValue(
		detected ? ["claude-code"] : [],
	);
}

describe("Update", () => {
	test("renders 'Checking installed agents...' during detection", async () => {
		// Never-resolving npm root keeps detection pending.
		stubExecFile(() => ({ stdout: "" }));
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const { frames } = render(<Update onDone={() => {}} />);
		await new Promise((r) => setTimeout(r, 10));
		expect(allFrames(frames)).toContain("Checking installed agents");
	});

	test("calls onDone(true) with a 'Nothing to update' message when no agents detected", async () => {
		stubContinueDetected(false);
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await new Promise((r) => setTimeout(r, 80));

		expect(allFrames(frames)).toContain("Nothing to update");
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("updates only tools detected under npm global root", async () => {
		stubContinueDetected(false);
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
		stubContinueDetected(false);
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

	test("updates the VS Code Continue extension when `code` is on PATH", async () => {
		// Continue YAML has CoDev's marker → schedule the extension update,
		// but skip JetBrains because no launcher is on PATH (ENOENT for all
		// three probes).
		stubContinueDetected(true);
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "code" && args[0] === "--version") {
				return { stdout: "1.96.0\n" };
			}
			if (file === "code" && args[0] === "--install-extension") {
				return { stdout: "ok" };
			}
			if (file === "idea" || file === "pycharm" || file === "goland") {
				const err = Object.assign(new Error(`spawn ${file} ENOENT`), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain("Updated continue.continue (VS Code)");
		// JetBrains task was not scheduled, so no row mentions it.
		expect(history).not.toContain("(JetBrains)");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("updates the JetBrains Continue plugin when a launcher is on PATH", async () => {
		// Continue YAML has CoDev's marker. No `code` on PATH (ENOENT), but
		// `idea` resolves — schedule only the JetBrains task.
		stubContinueDetected(true);
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "code") {
				const err = Object.assign(new Error("spawn code ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			if (file === "idea" && args[0] === "--version") {
				return { stdout: "2024.3" };
			}
			if (file === "idea" && args[0] === "installPlugins") {
				return { stdout: "ok" };
			}
			if (file === "pycharm" || file === "goland") {
				const err = Object.assign(new Error(`spawn ${file} ENOENT`), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain(
			"Updated com.github.continuedev.continueintellijextension (JetBrains)",
		);
		// VS Code task was not scheduled.
		expect(history).not.toContain("(VS Code)");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("updates the VS Code Claude Code extension when `code` is on PATH", async () => {
		// `~/.claude/settings.json` has the CoDev marker → schedule the
		// extension update. JetBrains launchers all ENOENT → no plugin task.
		stubClaudeCodeDetected(true);
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "code" && args[0] === "--version") {
				return { stdout: "1.96.0\n" };
			}
			if (file === "code" && args[0] === "--install-extension") {
				return { stdout: "ok" };
			}
			if (file === "idea" || file === "pycharm" || file === "goland") {
				const err = Object.assign(new Error(`spawn ${file} ENOENT`), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain("Updated anthropic.claude-code (VS Code)");
		expect(history).not.toContain("(JetBrains)");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("updates the JetBrains Claude Code plugin when a launcher is on PATH", async () => {
		stubClaudeCodeDetected(true);
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (file === "code") {
				const err = Object.assign(new Error("spawn code ENOENT"), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			if (file === "idea" && args[0] === "--version") {
				return { stdout: "2024.3" };
			}
			if (file === "idea" && args[0] === "installPlugins") {
				return { stdout: "ok" };
			}
			if (file === "pycharm" || file === "goland") {
				const err = Object.assign(new Error(`spawn ${file} ENOENT`), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain("Updated com.anthropic.code.plugin (JetBrains)");
		expect(history).not.toContain("(VS Code)");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});

	test("skips Continue entirely when no editor launcher is on PATH", async () => {
		// Continue is configured but neither editor's CLI resolves. Don't
		// schedule any Continue update task — users without `code` /
		// JetBrains launchers shouldn't see spurious launcher-not-found
		// warnings from a tool CoDev's update step decided to probe.
		stubContinueDetected(true);
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "root") return { stdout: "/fake/root" };
			if (
				file === "code" ||
				file === "idea" ||
				file === "pycharm" ||
				file === "goland"
			) {
				const err = Object.assign(new Error(`spawn ${file} ENOENT`), {
					code: "ENOENT",
				}) as NodeJS.ErrnoException;
				return { error: err };
			}
			return { stdout: "" };
		});
		const existsSpy = vi.mocked(fs.existsSync).mockReturnValue(false);
		const onDone = vi.fn(() => {});

		const { frames } = render(<Update onDone={onDone} />);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

		const history = allFrames(frames);
		expect(history).toContain("Nothing to update");
		expect(history).not.toContain("continue.continue");
		expect(history).not.toContain("(JetBrains)");
		expect(onDone).toHaveBeenCalledWith(true);
		existsSpy.mockRestore();
	});
});
