import * as child_process from "node:child_process";
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
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigApp } from "@/ConfigApp.js";
import * as auth from "@/lib/auth.js";
import * as backend from "@/lib/backend.js";
import * as codegraph from "@/lib/codegraph.js";
import * as configure from "@/lib/configure.js";

// ConfigApp shares its state machine with InstallApp (both render <SetupApp />).
// These tests cover only the config-specific deltas:
//   1. ToolSelect title verb is "configure", not "install".
//   2. The *agent* install never runs — no `Installing packages` row, no
//      `npm install` execFile calls. (Config mode DOES show a CodeGraph-only
//      "Installing CodeGraph" step right after login — see the CodeGraph
//      assertions — but the agents are treated as already installed.)
//   3. Configure / backupOnly still run for the selected tools (we want the
//      same on-disk effect as install, just without the agent install step).
// The full grid of auth methods, retries, partial-failure handling, etc., is
// already covered by InstallApp.test.tsx against the same component.

function stubModels() {
	return vi
		.spyOn(backend, "fetchModels")
		.mockResolvedValue(["m-alpha", "m-beta"]);
}

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

let configAppTempHome: string;

beforeEach(() => {
	configAppTempHome = mkdtempSync(join(tmpdir(), "codev-configapp-test-"));
	vi.stubEnv("HOME", configAppTempHome);
	vi.stubEnv("USERPROFILE", configAppTempHome);
	// Keep VS Code user-data dir resolution (vscode-settings.ts, invoked by the
	// finalize Phase on the configure path) inside the temp home on every
	// platform, so tests never touch the runner's real VS Code config.
	vi.stubEnv("APPDATA", join(configAppTempHome, "AppData", "Roaming"));
	vi.stubEnv("XDG_CONFIG_HOME", join(configAppTempHome, ".config"));
	// refreshCodevConfig hits the network. Mock it as a fast resolve so the
	// inline post-login refresh doesn't block tests on a real fetch.
	vi.spyOn(auth, "refreshCodevConfig").mockResolvedValue(undefined);
	// Config mode installs CodeGraph right after login
	// (ensureCodegraphInstalled) and wires it in finalize (setupCodegraph).
	// Default both to no-ops so the config-mode tests stay isolated from the
	// agent npm-install assertions below (which expect zero npm installs).
	vi.spyOn(codegraph, "ensureCodegraphInstalled").mockResolvedValue(null);
	vi.spyOn(codegraph, "setupCodegraph").mockResolvedValue({
		status: "skipped",
		targets: [],
	});
	// Default to "no saved API key" so the validating-existing branch doesn't
	// surface a stale dev-machine key.
	vi.spyOn(auth, "loadApiKey").mockReturnValue(null);
	// Stub the post-model gateway smoke test to a pass so full-flow tests don't
	// make a real completion call; the failure-path test overrides it.
	vi.spyOn(backend, "smokeTestModel").mockResolvedValue(null);
	// codev-code is always configured now, so the real configureCodevCode runs
	// in every flow. On the new-key path it would fall back to
	// AI_GATEWAY_OPENAI_URL() and hard-fail on the unpopulated gateway_url
	// cache, so stub it. Its output is covered by the provider/configure tests.
	vi.spyOn(configure, "configureCodevCode").mockReturnValue([
		{
			kind: "codev-code-config",
			sourcePath: "/tmp/codev-code.json",
			backupPath: "/tmp/codev-code.json.backup",
			created: true,
		},
	]);
});

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

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

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-cfg",
		id_token: "id-cfg",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

async function waitForFrame(
	frames: string[],
	needle: string,
	maxMs = 3_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (frames.join("\n").includes(needle)) {
			await new Promise((r) => setTimeout(r, 30));
			return;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function advanceThroughConfirm(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Title says "configure" in config mode (not "install"). Pick Claude Code
	// (second row, below CoDev Code), Enter, accept backup warning.
	await waitForFrame(frames, "Select the AI agent(s) to configure");
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await waitForFrame(frames, "Continue? [y/N]");
	stdin.write("y\r");
}

async function settleAfterLogin(
	_stdin: { write: (s: string) => void },
	frames: string[],
) {
	// Config mode jumps login → refreshing-config → key-choice (with a
	// CodeGraph-only install step in between when a selected agent maps to a
	// CodeGraph target).
	await waitForFrame(frames, "Choose configuration method");
}

async function pickManual(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	await settleAfterLogin(stdin, frames);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickSkip(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	await settleAfterLogin(stdin, frames);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function typeManualCreds(
	stdin: { write: (s: string) => void },
	frames: string[],
	baseUrl: string,
	apiKey: string,
	// The provider-name field comes first and is optional — an empty string
	// just Enters past it, leaving the default identity to the caller.
	providerName = "",
) {
	await waitForFrame(frames, "Enter API credentials");
	if (providerName) {
		stdin.write(providerName);
		await new Promise((r) => setTimeout(r, 30));
	}
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(baseUrl);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(apiKey);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickFirstModel(
	stdin: { write: (s: string) => void },
	frames: string[],
	expectedModel = "m-alpha",
) {
	await waitForFrame(frames, expectedModel);
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	rmSync(configAppTempHome, { recursive: true, force: true });
});

describe("ConfigApp", () => {
	test("ToolSelect uses 'configure' verb, not 'install'", async () => {
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());

		const { frames } = render(<ConfigApp />);
		await waitForFrame(frames, "Select the AI agent(s) to configure");

		const history = allFrames(frames);
		expect(history).toContain("Select the AI agent(s) to configure");
		expect(history).not.toContain("Select the AI agent(s) to install");
	});

	test("manual-creds happy path skips the Install Step and writes the configured tool", async () => {
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: true,
				},
			]);
		// Stub execFile in case anything attempts a shell-out — if the Install
		// Step were still mounted, `npm install` would land here. The
		// assertion below checks it was never called.
		const execFileMock = vi.mocked(child_process.execFile);
		stubExecFile(() => ({ stdout: "ok" }));

		const { stdin, frames } = render(<ConfigApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickManual(stdin, frames);
		await typeManualCreds(
			stdin,
			frames,
			"https://my-gateway.example.com/v1",
			"sk-cfg-123",
		);
		await pickFirstModel(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		// The *agent* install step never rendered (no "Installing packages"
		// title; config uses the CodeGraph-only "Installing CodeGraph" step).
		expect(history).not.toContain("Installing packages");
		expect(history).not.toContain("Failed to install");
		// No agent `npm install` ever attempted.
		const npmInstallCalls = execFileMock.mock.calls.filter((call) => {
			const first = call[0] as string;
			const second = call[1];
			if (Array.isArray(second)) {
				return first === "npm" && (second as string[])[0] === "i";
			}
			return first.startsWith("npm i");
		});
		expect(npmInstallCalls).toHaveLength(0);
		// Config mode DOES show a visible CodeGraph-only install step right after
		// login (labeled with the npm package name), then wires in finalize.
		expect(history).toContain("@colbymchenry/codegraph");
		expect(codegraph.ensureCodegraphInstalled).toHaveBeenCalled();
		// The always-on codev-code leads the tool set; claude-code is the one
		// that maps to a CodeGraph target.
		expect(codegraph.setupCodegraph).toHaveBeenCalledWith([
			"codev-code",
			"claude-code",
		]);
		// Configure still ran for the selected tool.
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-cfg-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
			providerId: "ai-gateway",
			providerName: "AI Gateway",
		});
		// codev-code is always configured too, even in config mode.
		expect(configure.configureCodevCode).toHaveBeenCalledWith({
			apiKey: "sk-cfg-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
			providerId: "ai-gateway",
			providerName: "AI Gateway",
		});
	});

	test("skip-configuration backs up live config without writing CoDev's settings", async () => {
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const configureSpy = vi.spyOn(configure, "configureClaudeCode");
		const backupOnlySpy = vi.spyOn(configure, "backupOnly").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);
		stubExecFile(() => ({ stdout: "ok" }));

		const { stdin, frames } = render(<ConfigApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickSkip(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(history).not.toContain("Installing packages");
		// Backup runs once for the always-on codev-code and once for the
		// selected claude-code.
		expect(backupOnlySpy).toHaveBeenCalledTimes(2);
		expect(backupOnlySpy).toHaveBeenCalledWith("codev-code");
		expect(backupOnlySpy).toHaveBeenCalledWith("claude-code");
		expect(configureSpy).not.toHaveBeenCalled();
		// Skip renders no backup Step; the configure-path rows (non-skip branch
		// of the same render) must not appear.
		expect(history).not.toContain("Configure tools");
		expect(history).not.toContain("Configured Claude Code");
	});
});

// Symmetric with InstallApp.test.tsx's "finalize: Claude file fate" — verifies
// that `codevhub config` honors the same Skip vs non-Skip routing for
// ~/.claude.json and ~/.claude/.credentials.json. SetupApp drives both modes
// so the wiring is shared; this is a cheap regression guard against a future
// mode-specific divergence.
describe("ConfigApp finalize: Claude file fate by auth choice", () => {
	function seedClaudeFiles(): {
		jsonPath: string;
		credPath: string;
		jsonOriginal: { marker: string };
		credOriginal: { session: string };
	} {
		const jsonPath = join(configAppTempHome, ".claude.json");
		const credDir = join(configAppTempHome, ".claude");
		const credPath = join(credDir, ".credentials.json");
		const jsonOriginal = { marker: "user-pre-codev-state" };
		const credOriginal = { session: "user-prior-session" };
		mkdirSync(credDir, { recursive: true });
		writeFileSync(jsonPath, JSON.stringify(jsonOriginal));
		writeFileSync(credPath, JSON.stringify(credOriginal));
		return { jsonPath, credPath, jsonOriginal, credOriginal };
	}

	test("Skip configuration preserves ~/.claude.json and ~/.claude/.credentials.json originals", async () => {
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		vi.spyOn(configure, "backupOnly").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);
		stubExecFile(() => ({ stdout: "ok" }));

		const { jsonPath, credPath, jsonOriginal, credOriginal } =
			seedClaudeFiles();

		const { stdin, frames } = render(<ConfigApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickSkip(stdin, frames);
		await waitForFrame(frames, "Happy coding");

		expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual(jsonOriginal);
		expect(existsSync(credPath)).toBe(true);
		expect(JSON.parse(readFileSync(credPath, "utf-8"))).toEqual(credOriginal);
		expect(JSON.parse(readFileSync(`${jsonPath}.backup`, "utf-8"))).toEqual(
			jsonOriginal,
		);
		expect(JSON.parse(readFileSync(`${credPath}.backup`, "utf-8"))).toEqual(
			credOriginal,
		);
	});

	test("manual-credentials path triggers the destructive reset", async () => {
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(backend, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(true);
		vi.spyOn(configure, "configureClaudeCode").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);
		stubExecFile(() => ({ stdout: "ok" }));

		const { jsonPath, credPath, jsonOriginal, credOriginal } =
			seedClaudeFiles();

		const { stdin, frames } = render(<ConfigApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickManual(stdin, frames);
		await typeManualCreds(
			stdin,
			frames,
			"https://gateway.example.com/v1",
			"sk-config-claude-123",
		);
		await pickFirstModel(stdin, frames, "m-alpha");
		await waitForFrame(frames, "Happy coding");

		expect(JSON.parse(readFileSync(`${jsonPath}.backup`, "utf-8"))).toEqual(
			jsonOriginal,
		);
		expect(JSON.parse(readFileSync(`${credPath}.backup`, "utf-8"))).toEqual(
			credOriginal,
		);
		expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual({
			hasCompletedOnboarding: true,
		});
		expect(existsSync(credPath)).toBe(false);
	});

	test("a failing gateway smoke test warns but still writes config", async () => {
		stubModels();
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		// The chosen model is rejected by the gateway — surface it at config time
		// instead of letting it 403 at the agent's first message.
		vi.spyOn(backend, "smokeTestModel").mockResolvedValue(
			"Gateway rejected a test request for m-alpha (HTTP 403): key not allowed to access model",
		);
		const configureSpy = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.backup",
					created: true,
				},
			]);
		stubExecFile(() => ({ stdout: "ok" }));
		seedClaudeFiles();

		const { stdin, frames } = render(<ConfigApp />);
		await advanceThroughConfirm(stdin, frames);
		await pickManual(stdin, frames);
		await typeManualCreds(
			stdin,
			frames,
			"https://gateway.example.com/v1",
			"sk-smoke-403",
		);
		await pickFirstModel(stdin, frames, "m-alpha");
		await waitForFrame(frames, "Happy coding");

		const history = allFrames(frames);
		expect(history).toContain("Verifying gateway access");
		expect(history).toContain("key not allowed to access model");
		// Best-effort: the warning is shown but does not block configuration.
		expect(configureSpy).toHaveBeenCalled();
	});
});
