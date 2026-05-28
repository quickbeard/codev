import * as child_process from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigApp } from "@/ConfigApp.js";
import * as auth from "@/lib/auth.js";
import * as configure from "@/lib/configure.js";
import * as proxy from "@/lib/proxy.js";

// ConfigApp shares its state machine with InstallApp (both render <SetupApp />).
// These tests cover only the config-specific deltas:
//   1. ToolSelect title verb is "configure", not "install".
//   2. The Install Step never mounts — no `Installing packages` row, no
//      `npm install` execFile calls.
//   3. Configure / backupOnly still run for the selected tools (we want the
//      same on-disk effect as install, just without the Install step).
// The full grid of auth methods, retries, partial-failure handling, etc., is
// already covered by InstallApp.test.tsx against the same component.

function stubModels() {
	return vi
		.spyOn(proxy, "fetchModels")
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
	// refreshCodevConfig hits the network. Mock it as a fast resolve so the
	// inline post-login refresh doesn't block tests on a real fetch.
	vi.spyOn(auth, "refreshCodevConfig").mockResolvedValue(undefined);
	// Default to "no saved API key" so the validating-existing branch doesn't
	// surface a stale dev-machine key.
	vi.spyOn(auth, "loadApiKey").mockReturnValue(null);
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
	// Title says "configure" in config mode (not "install"). Pick Claude Code,
	// Enter, accept backup warning.
	await waitForFrame(frames, "Select the AI agent(s) to configure");
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await waitForFrame(frames, "Continue? [y/N]");
	stdin.write("y\r");
}

async function settleAfterLogin(frames: string[]) {
	// Config mode jumps login → refreshing-config → key-choice directly.
	await waitForFrame(frames, "Choose configuration method");
}

async function pickManual(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	await settleAfterLogin(frames);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickSkip(
	stdin: { write: (s: string) => void },
	frames: string[],
) {
	await settleAfterLogin(frames);
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
) {
	await waitForFrame(frames, "Enter API credentials");
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
		// Install Step never rendered.
		expect(history).not.toContain("Installing packages");
		expect(history).not.toContain("Failed to install");
		// No `npm install` ever attempted.
		const npmInstallCalls = execFileMock.mock.calls.filter((call) => {
			const first = call[0] as string;
			const second = call[1];
			if (Array.isArray(second)) {
				return first === "npm" && (second as string[])[0] === "install";
			}
			return first.startsWith("npm install");
		});
		expect(npmInstallCalls).toHaveLength(0);
		// Configure still ran for the selected tool.
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-cfg-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "m-alpha",
			models: ["m-alpha", "m-beta"],
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
		expect(history).toContain("Backed up Claude Code");
		expect(backupOnlySpy).toHaveBeenCalledTimes(1);
		expect(backupOnlySpy).toHaveBeenCalledWith("claude-code");
		expect(configureSpy).not.toHaveBeenCalled();
	});
});
