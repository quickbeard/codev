import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CodegraphTarget,
	codegraphRunner,
	codegraphTargets,
	ensureCodegraphInstalled,
	forwardToCodegraph,
	runCodegraphInstall,
	runCodegraphUninstall,
	setupCodegraph,
	toolToCodegraphTarget,
} from "@/lib/codegraph.js";
import type { Tool } from "@/lib/configure.js";
import * as npm from "@/lib/npm.js";

describe("toolToCodegraphTarget", () => {
	test("maps the three CLI agents to their CodeGraph target", () => {
		expect(toolToCodegraphTarget("claude-code")).toBe("claude");
		expect(toolToCodegraphTarget("codex")).toBe("codex");
		expect(toolToCodegraphTarget("opencode")).toBe("opencode");
	});

	test("maps both Claude Code extension variants to `claude`", () => {
		expect(toolToCodegraphTarget("vscode-claude-code")).toBe("claude");
		expect(toolToCodegraphTarget("jetbrains-claude-code")).toBe("claude");
	});

	test("returns null for Continue (no CodeGraph target)", () => {
		expect(toolToCodegraphTarget("vscode-continue")).toBeNull();
		expect(toolToCodegraphTarget("jetbrains-continue")).toBeNull();
	});
});

describe("codegraphTargets", () => {
	test("dedupes claude-code + vscode-claude-code into a single `claude`", () => {
		expect(codegraphTargets(["claude-code", "vscode-claude-code"])).toEqual([
			"claude",
		]);
	});

	test("preserves selection order across distinct targets", () => {
		expect(codegraphTargets(["opencode", "codex", "claude-code"])).toEqual([
			"opencode",
			"codex",
			"claude",
		]);
	});

	test("drops tools with no CodeGraph target", () => {
		expect(codegraphTargets(["vscode-continue", "jetbrains-continue"])).toEqual(
			[],
		);
		expect(codegraphTargets(["codex", "vscode-continue"] as Tool[])).toEqual([
			"codex",
		]);
	});
});

describe("runCodegraphInstall", () => {
	let execSpy: MockInstance;

	beforeEach(() => {
		execSpy = vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ stdout: "", stderr: "", error: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("invokes the codegraph installer with the expected flags", async () => {
		const err = await runCodegraphInstall(["claude", "codex"]);
		expect(err).toBeNull();
		expect(execSpy).toHaveBeenCalledWith("codegraph", [
			"install",
			"--target",
			"claude,codex",
			"--location",
			"global",
			"--yes",
		]);
	});

	test("no-ops (success, no spawn) when there are no targets", async () => {
		const err = await runCodegraphInstall([]);
		expect(err).toBeNull();
		expect(execSpy).not.toHaveBeenCalled();
	});

	test("surfaces stderr as the error string on failure", async () => {
		execSpy.mockResolvedValue({
			stdout: "",
			stderr: "boom",
			error: new Error("exit 1"),
		});
		expect(await runCodegraphInstall(["claude"])).toBe("boom");
	});
});

describe("runCodegraphUninstall", () => {
	let execSpy: MockInstance;

	beforeEach(() => {
		execSpy = vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ stdout: "", stderr: "", error: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("invokes codegraph uninstall user-wide and non-interactively", async () => {
		const err = await runCodegraphUninstall();
		expect(err).toBeNull();
		expect(execSpy).toHaveBeenCalledWith("codegraph", [
			"uninstall",
			"--location",
			"global",
			"--yes",
		]);
	});

	test("returns the error string on failure (e.g. package already removed)", async () => {
		execSpy.mockResolvedValue({
			stdout: "",
			stderr: "spawn codegraph ENOENT",
			error: new Error("ENOENT"),
		});
		expect(await runCodegraphUninstall()).toBe("spawn codegraph ENOENT");
	});
});

describe("ensureCodegraphInstalled", () => {
	let execSpy: MockInstance;

	beforeEach(() => {
		execSpy = vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ stdout: "", stderr: "", error: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("runs `npm i -g` for the CodeGraph package", async () => {
		const err = await ensureCodegraphInstalled();
		expect(err).toBeNull();
		expect(execSpy).toHaveBeenCalledWith("npm", [
			"i",
			"-g",
			"@colbymchenry/codegraph",
		]);
	});

	test("returns the error string on failure", async () => {
		execSpy.mockResolvedValue({
			stdout: "",
			stderr: "npm exploded",
			error: new Error("exit 1"),
		});
		expect(await ensureCodegraphInstalled()).toBe("npm exploded");
	});
});

describe("setupCodegraph", () => {
	let execSpy: MockInstance;

	beforeEach(() => {
		execSpy = vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ stdout: "", stderr: "", error: null });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("skips entirely when no tool maps to a CodeGraph target", async () => {
		const result = await setupCodegraph(["vscode-continue"]);
		expect(result.status).toBe("skipped");
		expect(result.targets).toEqual([]);
		expect(execSpy).not.toHaveBeenCalled();
	});

	test("wires mapped targets via `codegraph install` only (no npm install)", async () => {
		const result = await setupCodegraph(["claude-code", "vscode-claude-code"]);
		expect(result.status).toBe("ok");
		expect(result.targets).toEqual(["claude"]);
		// The CLI install happens earlier now; setupCodegraph only wires the MCP
		// server, so it makes exactly one execAsync call (codegraph install) and
		// never `npm i -g`.
		expect(execSpy).toHaveBeenCalledTimes(1);
		expect(execSpy).toHaveBeenCalledWith("codegraph", [
			"install",
			"--target",
			"claude",
			"--location",
			"global",
			"--yes",
		]);
	});

	test("warns when codegraph install fails", async () => {
		execSpy.mockResolvedValue({
			stdout: "",
			stderr: "install exploded",
			error: new Error("exit 1"),
		});
		const result = await setupCodegraph(["opencode"]);
		expect(result.status).toBe("warning");
		expect(result.message).toContain("install exploded");
	});
});

describe("forwardToCodegraph", () => {
	let errorSpy: MockInstance;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Stub codegraphRunner.spawn with a fake child that emits a chosen
	// exit/error, mirroring tests/lib/run.test.ts's approach.
	function withFakeChild(emit: (child: ChildProcess) => void): MockInstance {
		const fakeChild = new EventEmitter() as unknown as ChildProcess;
		const spawnSpy = vi.spyOn(codegraphRunner, "spawn").mockImplementation(((
			..._args: unknown[]
		) => {
			queueMicrotask(() => emit(fakeChild));
			return fakeChild;
		}) as unknown as typeof codegraphRunner.spawn);
		return spawnSpy;
	}

	test("returns the child's exit code", async () => {
		withFakeChild((c) => c.emit("exit", 0, null));
		expect(await forwardToCodegraph(["status"])).toBe(0);
	});

	test("propagates a non-zero exit code", async () => {
		withFakeChild((c) => c.emit("exit", 3, null));
		expect(await forwardToCodegraph(["index"])).toBe(3);
	});

	test("forwards args verbatim to the spawned binary", async () => {
		const spy = withFakeChild((c) => c.emit("exit", 0, null));
		await forwardToCodegraph(["init", "-y"]);
		// POSIX form: (cmd, args, opts). On win32 it's a single joined string.
		if (process.platform === "win32") {
			expect(spy.mock.calls[0]?.[0]).toBe("codegraph init -y");
		} else {
			expect(spy.mock.calls[0]?.[0]).toBe("codegraph");
			expect(spy.mock.calls[0]?.[1]).toEqual(["init", "-y"]);
		}
	});

	test("returns 1 and prints an install hint on ENOENT", async () => {
		withFakeChild((c) => {
			const err: NodeJS.ErrnoException = new Error("spawn codegraph ENOENT");
			err.code = "ENOENT";
			c.emit("error", err);
		});
		expect(await forwardToCodegraph([])).toBe(1);
		const messages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
		expect(
			messages.some((m: string) =>
				m.includes("npm i -g @colbymchenry/codegraph"),
			),
		).toBe(true);
	});
});

// Type-level sanity: the exported union stays in sync with what the mapping
// can return (excludes Continue's null).
const _targets: CodegraphTarget[] = ["claude", "codex", "opencode"];
void _targets;
