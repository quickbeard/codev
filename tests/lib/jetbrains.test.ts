import * as child_process from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	CLAUDE_CODE_INTELLIJ_PLUGIN_ID,
	CONTINUE_INTELLIJ_PLUGIN_ID,
	installClaudeCodePlugin,
	installContinuePlugin,
	JETBRAINS_CLIS,
} from "@/lib/jetbrains.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

// The macOS fallback in jetbrains.ts walks /Applications and ~/Applications
// for `.app` bundles whose embedded binary matches the launcher name. Mock
// node:fs so the host's actual /Applications (which on the maintainer's box
// contains PyCharm.app) doesn't leak into PATH-only tests. Default behavior
// is "nothing installed"; tests that exercise the fallback override
// readdirSync/existsSync explicitly.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readdirSync: vi.fn(() => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		}),
		existsSync: vi.fn(() => false),
	};
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

	test("trims trailing newline from error.message", async () => {
		// execFile's Error.message is "Command failed: <argv>\n…" with a
		// trailing newline. Without trimming, Install.tsx's `". <hint>"`
		// suffix lands on its own line because the embedded \n breaks the
		// row warning across lines.
		stubExecFile({
			handler: (file) => {
				if (file === "idea") {
					return {
						error: new Error(
							"Command failed: idea installPlugins foo\n",
						) as NodeJS.ErrnoException,
						stderr: "",
					};
				}
				return { error: enoent(file) };
			},
		});
		const result = await installContinuePlugin();
		expect(result).toEqual({
			warning: "idea: Command failed: idea installPlugins foo",
		});
	});
});

describe("installClaudeCodePlugin", () => {
	test("invokes each JetBrains CLI on PATH with `installPlugins <claude-code id>`", async () => {
		// Mirror of the Continue test — confirms the wrapper threads the
		// Claude Code plugin id through the shared installPlugin helper.
		const calls = stubExecFile({
			handler: (file) =>
				file === "idea" ? { stdout: "ok" } : { error: enoent(file) },
		});
		const result = await installClaudeCodePlugin();

		expect(result).toBeNull();
		expect(calls.map((c) => c.file)).toEqual([...JETBRAINS_CLIS]);
		for (const c of calls) {
			expect(c.args).toEqual([
				"installPlugins",
				CLAUDE_CODE_INTELLIJ_PLUGIN_ID,
			]);
		}
	});

	test("returns a soft warning when no JetBrains CLI is on PATH", async () => {
		stubExecFile({ handler: (file) => ({ error: enoent(file) }) });
		const result = await installClaudeCodePlugin();
		expect(result).toEqual({
			warning:
				"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
		});
	});
});

// macOS users frequently install JetBrains IDEs via the official `.dmg`
// without enabling Toolbox's "Generate shell scripts" option, so the
// `pycharm` / `idea` / `goland` launchers never land on PATH. The fallback
// resolves the launcher to `<Bundle>.app/Contents/MacOS/<cli>` under
// /Applications or ~/Applications and runs `installPlugins` against that
// binary instead.
describe("installContinuePlugin (macOS .app fallback)", () => {
	const origPlatform = process.platform;
	beforeEach(() => {
		Object.defineProperty(process, "platform", {
			value: "darwin",
			configurable: true,
		});
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", {
			value: origPlatform,
			configurable: true,
		});
	});

	test("invokes the .app binary when the PATH launcher is missing", async () => {
		// /Applications has PyCharm.app installed but no `pycharm` launcher
		// is on PATH (user never ran Toolbox's "Generate shell scripts").
		vi.mocked(readdirSync).mockImplementation(((root: string) => {
			if (root === "/Applications") return ["PyCharm.app"];
			return [];
		}) as unknown as typeof readdirSync);
		vi.mocked(existsSync).mockImplementation(
			((p: string) =>
				p ===
				"/Applications/PyCharm.app/Contents/MacOS/pycharm") as unknown as typeof existsSync,
		);
		const calls = stubExecFile({
			handler: (file) => {
				if (file === "/Applications/PyCharm.app/Contents/MacOS/pycharm")
					return { stdout: "ok" };
				return { error: enoent(file) };
			},
		});

		const result = await installContinuePlugin();

		expect(result).toBeNull();
		// idea + goland: PATH probe only (no .app installed → no retry).
		// pycharm: PATH probe ENOENT, then retry against the .app binary.
		expect(calls.map((c) => c.file)).toEqual([
			"idea",
			"pycharm",
			"/Applications/PyCharm.app/Contents/MacOS/pycharm",
			"goland",
		]);
		const pycharmAppCall = calls.find((c) => c.file.includes("PyCharm.app"));
		expect(pycharmAppCall?.args).toEqual([
			"installPlugins",
			CONTINUE_INTELLIJ_PLUGIN_ID,
		]);
	});

	test("matches edition variants by .app name prefix", async () => {
		// Ultimate edition installs as "IntelliJ IDEA Ultimate.app"; CE as
		// "IntelliJ IDEA CE.app". The fallback should accept any bundle whose
		// stem starts with the canonical name.
		vi.mocked(readdirSync).mockImplementation(((root: string) => {
			if (root === "/Applications") return ["IntelliJ IDEA Ultimate.app"];
			return [];
		}) as unknown as typeof readdirSync);
		vi.mocked(existsSync).mockImplementation(
			((p: string) =>
				p ===
				"/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea") as unknown as typeof existsSync,
		);
		const calls = stubExecFile({
			handler: (file) => {
				if (
					file ===
					"/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea"
				)
					return { stdout: "ok" };
				return { error: enoent(file) };
			},
		});

		const result = await installContinuePlugin();
		expect(result).toBeNull();
		expect(
			calls.some(
				(c) =>
					c.file ===
					"/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea",
			),
		).toBe(true);
	});

	test("does not retry when the .app exists but the embedded binary is missing", async () => {
		// Defensive: a stale or broken bundle without Contents/MacOS/<cli>
		// should fall through to the soft warning, not crash. existsSync
		// stays false for the binary path.
		vi.mocked(readdirSync).mockImplementation(((root: string) => {
			if (root === "/Applications") return ["PyCharm.app"];
			return [];
		}) as unknown as typeof readdirSync);
		stubExecFile({ handler: (file) => ({ error: enoent(file) }) });

		const result = await installContinuePlugin();
		expect(result).toEqual({
			warning:
				"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
		});
	});
});
