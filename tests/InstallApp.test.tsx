import * as child_process from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InstallApp } from "@/InstallApp.js";
import * as auth from "@/lib/auth.js";
import * as configure from "@/lib/configure.js";
import * as proxy from "@/lib/proxy.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

// InstallApp's manual-creds path calls saveApiKey(), which writes to
// ~/.codev/auth.json. Without this redirect, every test run would clobber the
// developer's real auth.json with fixture keys like "sk-manual-123".
let installAppTempHome: string;

beforeEach(() => {
	installAppTempHome = mkdtempSync(join(tmpdir(), "codev-installapp-test-"));
	vi.stubEnv("HOME", installAppTempHome);
	// refreshCodevConfig hits the network. Mock it as a fast resolve so the
	// new `refreshing-config` phase doesn't block the test on real fetch.
	vi.spyOn(auth, "refreshCodevConfig").mockResolvedValue(undefined);
});

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function stubExecFile(
	handler: (
		file: string,
		args: string[],
	) => {
		error?: Error | null;
		stdout?: string;
		stderr?: string;
	},
) {
	vi.mocked(child_process.execFile).mockImplementation(((
		file: string,
		args: string[],
		...rest: unknown[]
	) => {
		const cb = rest[rest.length - 1] as ExecCb;
		const r = handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
}

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-xyz",
		id_token: "id-xyz",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

async function advanceThroughConfirm(stdin: { write: (s: string) => void }) {
	// Select Claude Code, confirm selection, accept backup-warning confirm
	// (apt-style: type "y" then Enter). Lands on LOGIN.
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("y\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function advanceThroughConfirmCodex(stdin: {
	write: (s: string) => void;
}) {
	// Move cursor to the second option (Codex), select, confirm, accept warning.
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(" ");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("y\r");
	await new Promise((r) => setTimeout(r, 30));
}

// After install completes, the proxy-url-choice screen appears with the
// cursor on "Use default CoDev proxy URL". Enter picks it; refreshing-config
// resolves immediately because refreshCodevConfig is mocked in beforeEach.
async function advanceProxyUrlChoice(stdin: { write: (s: string) => void }) {
	await new Promise((r) => setTimeout(r, 200));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 100));
}

async function pickNewKey(stdin: { write: (s: string) => void }) {
	// Wait for login + install + proxy-url + refresh + validation to settle and
	// the key-choice screen to appear, then press Enter on the default first
	// option ("Get a new API Key" when no saved key exists).
	await advanceProxyUrlChoice(stdin);
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickManual(stdin: { write: (s: string) => void }) {
	// Wait for the upstream phases to settle, move cursor to "I have my
	// own API Key", Enter.
	await advanceProxyUrlChoice(stdin);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function pickSkip(stdin: { write: (s: string) => void }) {
	// Wait for the upstream phases to settle, move cursor past
	// "Get a new API Key" and "I have my own API Key" to land on
	// "Skip configuration", Enter.
	await advanceProxyUrlChoice(stdin);
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\x1B[B");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

async function typeManualCreds(
	stdin: { write: (s: string) => void },
	baseUrl: string,
	apiKey: string,
	model: string,
) {
	stdin.write(baseUrl);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(apiKey);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
	stdin.write(model);
	await new Promise((r) => setTimeout(r, 30));
	stdin.write("\r");
	await new Promise((r) => setTimeout(r, 30));
}

// `useApp().exit()` unmounts the tree so the final `lastFrame()` is blank.
// Inspect the full frame history instead to assert what the app did render.
function allFrames(frames: string[]): string {
	return frames.join("\n");
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	rmSync(installAppTempHome, { recursive: true, force: true });
});

// Default to "no saved API key" for tests that exercise the new/manual paths —
// otherwise InstallApp would discover whatever is in the dev's real
// ~/.codev/auth.json and route through the validating-existing branch.
function stubNoSavedKey() {
	vi.spyOn(auth, "loadApiKey").mockReturnValue(null);
}

describe("InstallApp fail-stop invariant", () => {
	beforeEach(() => {
		stubNoSavedKey();
	});

	test("login failure halts the flow before install runs", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockImplementation(() =>
			Promise.reject(new Error("Connection refused")),
		);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("Login failed: Connection refused");
		expect(history).not.toContain("Installing packages");
		expect(history).not.toContain("Configure tools");
	});

	test("install failure does not advance to key-choice", async () => {
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		stubExecFile((file, args) => {
			if (file === "npm" && args[0] === "install") {
				const err = Object.assign(new Error("spawn npm ENOENT"), {
					code: "ENOENT",
				});
				return { error: err, stderr: "spawn npm ENOENT" };
			}
			return { stdout: "1.0.0" };
		});

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await new Promise((r) => setTimeout(r, 300));

		const history = allFrames(frames);
		expect(history).toContain("Failed to install");
		expect(history).not.toContain("Get a new API Key");
		expect(history).not.toContain("Configure tools");
	});

	test("fetch-key failure halts the flow before configure", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockImplementation(() =>
			Promise.reject(new Error("Proxy /auth/exchange failed (502): boom")),
		);
		const configureSpy = vi.spyOn(configure, "configureClaudeCode");

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickNewKey(stdin);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		expect(history).toContain("Failed to fetch API key");
		expect(history).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(history).not.toContain("Configure tools");
		expect(configureSpy).not.toHaveBeenCalled();
	});

	test("configure failure does not reach the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-123");
		vi.spyOn(configure, "configureClaudeCode").mockImplementation(() => {
			throw new Error("disk full");
		});

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickNewKey(stdin);
		await new Promise((r) => setTimeout(r, 300));

		const history = allFrames(frames);
		expect(history).toContain("Configure tools");
		expect(history).toContain("Configure failed: disk full");
		expect(history).not.toContain("Happy coding");
	});

	test("successful flow reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-123");
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

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickNewKey(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(configureSpy).toHaveBeenCalledWith({ apiKey: "sk-test-123" });
	});

	test("Codex selection routes to configureCodex and reaches done", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-codex-123");
		const configureCodexSpy = vi
			.spyOn(configure, "configureCodex")
			.mockReturnValue([
				{
					kind: "codex-config",
					sourcePath: "/tmp/codex.toml",
					backupPath: "/tmp/codex.toml.backup",
					created: true,
				},
			]);
		configureCodexSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirmCodex(stdin);
		await pickNewKey(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(configureCodexSpy).toHaveBeenCalledTimes(1);
		expect(configureCodexSpy).toHaveBeenCalledWith({ apiKey: "sk-codex-123" });
	});

	test("manual-credentials flow reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(proxy, "fetchApiKey")
			.mockImplementation(() => new Promise(() => {}));
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
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickManual(stdin);
		await typeManualCreds(
			stdin,
			"https://my-gateway.example.com/v1",
			"sk-manual-123",
			"custom-model",
		);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Enter API credentials");
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(1);
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-manual-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "custom-model",
		});
	});

	test("empty-key retry then second empty falls back into manual creds", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi.spyOn(proxy, "fetchApiKey").mockResolvedValue("");
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
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickNewKey(stdin);

		// First empty result — retry prompt should render, no fallback yet.
		await new Promise((r) => setTimeout(r, 200));
		expect(allFrames(frames)).toContain("Gateway returned an empty API key.");
		expect(allFrames(frames)).toContain("Press Enter to retry");
		expect(allFrames(frames)).not.toContain(
			"Press Enter to enter credentials manually",
		);

		// Press Enter to retry; second attempt also returns empty.
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 200));
		expect(allFrames(frames)).toContain(
			"Gateway returned an empty API key again.",
		);
		expect(allFrames(frames)).toContain(
			"Press Enter to enter credentials manually",
		);
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to drop into manual creds.
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));
		expect(allFrames(frames)).toContain("Enter API credentials");

		await typeManualCreds(
			stdin,
			"https://fallback.example.com/v1",
			"sk-fallback-123",
			"fallback-model",
		);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(fetchApiKeySpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-fallback-123",
			baseUrl: "https://fallback.example.com/v1",
			model: "fallback-model",
		});
	});

	test("fetch-key retry after failure reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(proxy, "fetchApiKey")
			.mockImplementationOnce(() =>
				Promise.reject(new Error("Proxy /auth/exchange failed (502): boom")),
			)
			.mockImplementationOnce(() => Promise.resolve("sk-retry-ok"));
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
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickNewKey(stdin);

		// First attempt rejects — retry prompt renders.
		await new Promise((r) => setTimeout(r, 200));
		expect(allFrames(frames)).toContain(
			"Failed to fetch API key: Proxy /auth/exchange failed",
		);
		expect(allFrames(frames)).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to retry; second attempt resolves.
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(fetchApiKeySpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
		expect(configureSpy).toHaveBeenCalledWith({ apiKey: "sk-retry-ok" });
	});

	test("skip-configuration flow backs up but does not write configs", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(proxy, "fetchApiKey")
			.mockImplementation(() => new Promise(() => {}));
		const configureSpy = vi.spyOn(configure, "configureClaudeCode");
		const backupOnlySpy = vi.spyOn(configure, "backupOnly").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: true,
			},
		]);
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();
		backupOnlySpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickSkip(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Skip configuration");
		expect(history).toContain("Back up existing configs");
		expect(history).toContain("Backed up Claude Code");
		expect(history).toContain("Happy coding");
		expect(backupOnlySpy).toHaveBeenCalledTimes(1);
		expect(backupOnlySpy).toHaveBeenCalledWith("claude-code");
		expect(configureSpy).not.toHaveBeenCalled();
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
	});

	test("skip-configuration with pre-existing backup reports it as preserved, not re-backed-up", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		vi.spyOn(configure, "backupOnly").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: "/tmp/x.backup",
				created: false,
			},
		]);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickSkip(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain(
			"Claude Code backup already exists — left untouched",
		);
		expect(history).not.toContain("Backed up Claude Code");
	});

	test("skip-configuration with no live config reports nothing to back up", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);
		vi.spyOn(configure, "backupOnly").mockReturnValue([
			{
				kind: "claude-settings",
				sourcePath: "/tmp/x",
				backupPath: null,
				created: false,
			},
		]);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await pickSkip(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Nothing to back up for Claude Code");
		expect(history).not.toContain("Backed up Claude Code");
	});

	test("login retry after failure reaches the done screen", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		const loginSpy = vi
			.spyOn(auth, "login")
			.mockImplementationOnce(() => Promise.reject(new Error("network down")))
			.mockImplementationOnce(() => Promise.resolve(fakeAuth()));
		vi.spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-123");
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
		loginSpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);

		// Wait for the first login attempt to reject.
		await new Promise((r) => setTimeout(r, 200));
		expect(allFrames(frames)).toContain("Login failed: network down");
		expect(allFrames(frames)).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(configureSpy).not.toHaveBeenCalled();

		// Press Enter to retry login.
		stdin.write("\r");
		await pickNewKey(stdin);
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(2);
		expect(configureSpy).toHaveBeenCalledTimes(1);
	});
});

describe("InstallApp existing-key path", () => {
	test("validating an existing key shows it, surfaces the option, and reuses saved creds", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		const loadSpy = vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-existing-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "saved-model",
		});
		const validateSpy = vi
			.spyOn(proxy, "validateApiKey")
			.mockResolvedValue(true);
		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const fetchApiKeySpy = vi
			.spyOn(proxy, "fetchApiKey")
			.mockImplementation(() => new Promise(() => {}));
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
		loadSpy.mockClear();
		validateSpy.mockClear();
		loginSpy.mockClear();
		fetchApiKeySpy.mockClear();
		configureSpy.mockClear();

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await advanceProxyUrlChoice(stdin);
		// Wait for refresh + validation to settle and key-choice to render
		// with the new option as the default cursor.
		await new Promise((r) => setTimeout(r, 300));

		const beforeChoice = allFrames(frames);
		expect(beforeChoice).toContain("Reuse existing API Key");
		expect(beforeChoice).toContain("Get a new API Key");

		// Default cursor is on the existing option — Enter selects it directly.
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 1_300));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
		expect(loginSpy).toHaveBeenCalledTimes(1);
		expect(fetchApiKeySpy).not.toHaveBeenCalled();
		expect(validateSpy).toHaveBeenCalledTimes(1);
		expect(validateSpy).toHaveBeenCalledWith(
			"sk-existing-123",
			"https://my-gateway.example.com/v1",
		);
		expect(configureSpy).toHaveBeenCalledWith({
			apiKey: "sk-existing-123",
			baseUrl: "https://my-gateway.example.com/v1",
			model: "saved-model",
		});
	});

	test("invalid saved key surfaces an error and does not show the existing option", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "loadApiKey").mockReturnValue({ apiKey: "sk-stale" });
		vi.spyOn(proxy, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await advanceProxyUrlChoice(stdin);
		await new Promise((r) => setTimeout(r, 300));

		const history = allFrames(frames);
		expect(history).toContain("Saved API key is no longer valid");
		expect(history).not.toContain("Reuse existing API Key");
		expect(history).toContain("Get a new API Key");
	});

	test("validation network error is reported and option is hidden", async () => {
		stubExecFile(() => ({ stdout: "ok" }));
		vi.spyOn(auth, "loadApiKey").mockReturnValue({ apiKey: "sk-x" });
		vi.spyOn(proxy, "validateApiKey").mockRejectedValue(
			new Error("fetch failed: ECONNREFUSED"),
		);
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		vi.spyOn(proxy, "fetchApiKey").mockImplementation(
			() => new Promise(() => {}),
		);

		const { stdin, frames } = render(<InstallApp />);
		await advanceThroughConfirm(stdin);
		await advanceProxyUrlChoice(stdin);
		await new Promise((r) => setTimeout(r, 300));

		const history = allFrames(frames);
		expect(history).toContain("Could not verify saved API key");
		expect(history).toContain("ECONNREFUSED");
		expect(history).not.toContain("Reuse existing API Key");
	});
});
