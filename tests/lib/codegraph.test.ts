import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	CODEV_TARGET_SPEC,
	type CodegraphTarget,
	codegraphEligible,
	codegraphRunner,
	codegraphTargets,
	detectCodegraphInstalled,
	ensureCodegraphInstalled,
	formatCodegraphTargets,
	forwardToCodegraph,
	registerCodevTarget,
	runCodegraphInstall,
	runCodegraphUninstall,
	setupCodegraph,
	supportsCustomTargets,
	toolToCodegraphTarget,
	unwireCodevCodeMcp,
	wireCodevCodeMcp,
} from "@/lib/codegraph.js";
import type { Tool } from "@/lib/configure.js";
import * as npm from "@/lib/npm.js";

// The entry both wiring paths produce — mirrors codegraph's opencode family.
const MCP_ENTRY = {
	type: "local",
	command: ["codegraph", "serve", "--mcp"],
	enabled: true,
};

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

describe("codegraphEligible", () => {
	test("true when a tool maps to a built-in target", () => {
		expect(codegraphEligible(["codex"])).toBe(true);
		expect(codegraphEligible(["vscode-claude-code"])).toBe(true);
	});

	test("true for a codev-code-only selection (custom target / shim path)", () => {
		expect(codegraphEligible(["codev-code"])).toBe(true);
		expect(codegraphEligible(["codev-code", "vscode-continue"])).toBe(true);
	});

	test("false for Continue-only selections", () => {
		expect(codegraphEligible(["vscode-continue", "jetbrains-continue"])).toBe(
			false,
		);
		expect(codegraphEligible([])).toBe(false);
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

describe("formatCodegraphTargets", () => {
	test("maps target ids to display names", () => {
		expect(formatCodegraphTargets(["claude"])).toBe("Claude Code");
		expect(formatCodegraphTargets(["codex"])).toBe("Codex");
		expect(formatCodegraphTargets(["opencode"])).toBe("OpenCode");
		expect(formatCodegraphTargets(["codev"])).toBe("CoDev Code");
	});

	test("joins two targets with 'and' (no comma)", () => {
		expect(formatCodegraphTargets(["codex", "opencode"])).toBe(
			"Codex and OpenCode",
		);
	});

	test("joins three targets with an Oxford comma", () => {
		expect(formatCodegraphTargets(["claude", "codex", "opencode"])).toBe(
			"Claude Code, Codex, and OpenCode",
		);
	});

	test("preserves the given order", () => {
		expect(formatCodegraphTargets(["opencode", "claude"])).toBe(
			"OpenCode and Claude Code",
		);
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

describe("detectCodegraphInstalled", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("delegates to isPackageInstalledGlobally with the CodeGraph package", async () => {
		const spy = vi
			.spyOn(npm, "isPackageInstalledGlobally")
			.mockResolvedValue(true);
		expect(await detectCodegraphInstalled()).toBe(true);
		expect(spy).toHaveBeenCalledWith("@colbymchenry/codegraph");
	});

	test("returns false when the package isn't globally installed", async () => {
		vi.spyOn(npm, "isPackageInstalledGlobally").mockResolvedValue(false);
		expect(await detectCodegraphInstalled()).toBe(false);
	});
});

describe("supportsCustomTargets", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("probes with the read-only `targets list` and reports support", async () => {
		const execSpy = vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ stdout: "codev", stderr: "", error: null });
		expect(await supportsCustomTargets()).toBe(true);
		expect(execSpy).toHaveBeenCalledWith("codegraph", ["targets", "list"]);
	});

	test("reports no support when the binary rejects the command", async () => {
		vi.spyOn(npm, "execAsync").mockResolvedValue({
			stdout: "",
			stderr: "error: unknown command 'targets'",
			error: new Error("exit 1"),
		});
		expect(await supportsCustomTargets()).toBe(false);
	});
});

describe("registerCodevTarget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("upserts the CoDev Code spec via `targets add`", async () => {
		const execSpy = vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ stdout: "", stderr: "", error: null });
		expect(await registerCodevTarget()).toBeNull();
		expect(execSpy).toHaveBeenCalledWith("codegraph", [
			"targets",
			"add",
			CODEV_TARGET_SPEC,
		]);
		// The spec must satisfy `targets add` validation: opencode family keyed
		// by appName, with the id the install CSV will reference.
		expect(JSON.parse(CODEV_TARGET_SPEC)).toMatchObject({
			id: "codev",
			family: "opencode",
			appName: "codev",
		});
	});

	test("surfaces stderr as the error string on failure", async () => {
		vi.spyOn(npm, "execAsync").mockResolvedValue({
			stdout: "",
			stderr: "invalid spec",
			error: new Error("exit 1"),
		});
		expect(await registerCodevTarget()).toBe("invalid spec");
	});
});

describe("wireCodevCodeMcp / unwireCodevCodeMcp", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "codev-codegraph-test-"));
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("USERPROFILE", tempDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const jsonPath = () => join(tempDir, ".config", "codev", "codev.json");
	const jsoncPath = () => join(tempDir, ".config", "codev", "codev.jsonc");

	test("creates codev.json with $schema and the mcp entry from scratch", () => {
		expect(wireCodevCodeMcp()).toBeNull();
		const config = JSON.parse(readFileSync(jsonPath(), "utf-8"));
		expect(config.$schema).toBe("https://opencode.ai/config.json");
		expect(config.mcp.codegraph).toEqual(MCP_ENTRY);
	});

	test("adds the entry to an existing jsonc, preserving comments and sibling servers", () => {
		mkdirSync(join(tempDir, ".config", "codev"), { recursive: true });
		writeFileSync(
			jsoncPath(),
			`{
  // the user's own server
  "mcp": {
    "mine": { "type": "local", "command": ["mine"], "enabled": true }
  }
}
`,
		);
		expect(wireCodevCodeMcp()).toBeNull();
		// An existing .jsonc is the fork's preferred read target — the shim must
		// edit it, not shadow it with a fresh .json.
		expect(existsSync(jsonPath())).toBe(false);
		const text = readFileSync(jsoncPath(), "utf-8");
		// The comment and the user's own server both survive the surgical edit.
		expect(text).toContain("// the user's own server");
		expect(text).toContain('"mine"');
		expect(text).toContain('"codegraph"');
	});

	test("is idempotent — an already-correct entry leaves the file byte-identical", () => {
		expect(wireCodevCodeMcp()).toBeNull();
		const before = readFileSync(jsonPath(), "utf-8");
		expect(wireCodevCodeMcp()).toBeNull();
		expect(readFileSync(jsonPath(), "utf-8")).toBe(before);
	});

	test("refuses to edit a file with syntax errors and reports it", () => {
		mkdirSync(join(tempDir, ".config", "codev"), { recursive: true });
		writeFileSync(jsonPath(), "{ definitely not json");
		const err = wireCodevCodeMcp();
		expect(err).toContain("syntax errors");
		expect(readFileSync(jsonPath(), "utf-8")).toBe("{ definitely not json");
	});

	test("unwire removes the entry and drops an emptied mcp wrapper", () => {
		expect(wireCodevCodeMcp()).toBeNull();
		expect(unwireCodevCodeMcp()).toBeNull();
		const config = JSON.parse(readFileSync(jsonPath(), "utf-8"));
		expect(config.mcp).toBeUndefined();
		// The rest of the file survives.
		expect(config.$schema).toBe("https://opencode.ai/config.json");
	});

	test("unwire preserves sibling mcp servers", () => {
		mkdirSync(join(tempDir, ".config", "codev"), { recursive: true });
		writeFileSync(
			jsonPath(),
			JSON.stringify(
				{
					mcp: {
						codegraph: MCP_ENTRY,
						mine: { type: "local", command: ["mine"], enabled: true },
					},
				},
				null,
				2,
			),
		);
		expect(unwireCodevCodeMcp()).toBeNull();
		const config = JSON.parse(readFileSync(jsonPath(), "utf-8"));
		expect(config.mcp.codegraph).toBeUndefined();
		expect(config.mcp.mine.command).toEqual(["mine"]);
	});

	test("unwire no-ops when the file or the entry is absent", () => {
		// No file at all.
		expect(unwireCodevCodeMcp()).toBeNull();
		expect(existsSync(jsonPath())).toBe(false);
		// File without the entry: left byte-identical.
		mkdirSync(join(tempDir, ".config", "codev"), { recursive: true });
		const body = JSON.stringify({ theme: "dark" }, null, 2);
		writeFileSync(jsonPath(), body);
		expect(unwireCodevCodeMcp()).toBeNull();
		expect(readFileSync(jsonPath(), "utf-8")).toBe(body);
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

	test("never probes for custom targets when codev-code isn't selected", async () => {
		await setupCodegraph(["claude-code", "codex"]);
		const probeCalls = execSpy.mock.calls.filter(
			(c) => (c[1] as string[])[0] === "targets",
		);
		expect(probeCalls).toEqual([]);
	});
});

// The codev-code wiring inside setupCodegraph touches the real filesystem on
// the shim path, so these run against a stubbed HOME like the wire/unwire
// suite above.
describe("setupCodegraph with codev-code", () => {
	let tempDir: string;
	let execSpy: MockInstance;

	// Route execAsync by subcommand: `targets list` (the probe) and `targets
	// add` (registration) get configurable results; everything else (the
	// install) succeeds and is captured for CSV assertions.
	function routeExec(opts: { probeOk: boolean; addOk?: boolean }) {
		execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
			const ok = { stdout: "", stderr: "", error: null };
			const fail = (msg: string) => ({
				stdout: "",
				stderr: msg,
				error: new Error("exit 1"),
			});
			if (args[0] === "targets" && args[1] === "list") {
				return opts.probeOk ? ok : fail("unknown command 'targets'");
			}
			if (args[0] === "targets" && args[1] === "add") {
				return (opts.addOk ?? true) ? ok : fail("spec rejected");
			}
			return ok;
		});
	}

	function installCsv(): string | undefined {
		const call = execSpy.mock.calls.find(
			(c) => (c[1] as string[])[0] === "install",
		);
		return call ? (call[1] as string[])[2] : undefined;
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "codev-codegraph-setup-test-"));
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("USERPROFILE", tempDir);
		execSpy = vi.spyOn(npm, "execAsync");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	const jsonPath = () => join(tempDir, ".config", "codev", "codev.json");

	test("Path A: capable binary ⇒ registers the custom target, `codev` joins the CSV, no direct write", async () => {
		routeExec({ probeOk: true });
		const result = await setupCodegraph(["claude-code", "codev-code"]);
		expect(result.status).toBe("ok");
		expect(result.targets).toEqual(["claude", "codev"]);
		expect(execSpy).toHaveBeenCalledWith("codegraph", [
			"targets",
			"add",
			CODEV_TARGET_SPEC,
		]);
		expect(installCsv()).toBe("claude,codev");
		// codegraph owns the write on this path — the shim must not run.
		expect(existsSync(jsonPath())).toBe(false);
	});

	test("Path B: older binary ⇒ CSV stays built-in-only and the shim writes the entry", async () => {
		routeExec({ probeOk: false });
		const result = await setupCodegraph(["claude-code", "codev-code"]);
		expect(result.status).toBe("ok");
		expect(result.targets).toEqual(["claude", "codev"]);
		expect(installCsv()).toBe("claude");
		const config = JSON.parse(readFileSync(jsonPath(), "utf-8"));
		expect(config.mcp.codegraph).toEqual(MCP_ENTRY);
	});

	test("Path B with a codev-code-only selection: no install call at all, entry still written", async () => {
		routeExec({ probeOk: false });
		const result = await setupCodegraph(["codev-code"]);
		expect(result.status).toBe("ok");
		expect(result.targets).toEqual(["codev"]);
		expect(installCsv()).toBeUndefined();
		const config = JSON.parse(readFileSync(jsonPath(), "utf-8"));
		expect(config.mcp.codegraph).toEqual(MCP_ENTRY);
	});

	test("falls back to the shim when registration fails on a capable binary", async () => {
		routeExec({ probeOk: true, addOk: false });
		const result = await setupCodegraph(["codev-code"]);
		expect(result.status).toBe("ok");
		expect(result.targets).toEqual(["codev"]);
		expect(installCsv()).toBeUndefined();
		const config = JSON.parse(readFileSync(jsonPath(), "utf-8"));
		expect(config.mcp.codegraph).toEqual(MCP_ENTRY);
	});

	test("a failing shim write folds into a warning without dropping built-in wiring", async () => {
		routeExec({ probeOk: false });
		// An unparseable existing config makes the shim refuse to edit.
		mkdirSync(join(tempDir, ".config", "codev"), { recursive: true });
		writeFileSync(jsonPath(), "{ definitely not json");
		const result = await setupCodegraph(["claude-code", "codev-code"]);
		expect(result.status).toBe("warning");
		expect(result.message).toContain("CoDev Code MCP wiring failed");
		expect(result.targets).toEqual(["claude"]);
		expect(installCsv()).toBe("claude");
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
