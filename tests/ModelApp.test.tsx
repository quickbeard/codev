import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as auth from "@/lib/auth.js";
import * as configure from "@/lib/configure.js";
import * as proxy from "@/lib/proxy.js";
import { ModelApp } from "@/ModelApp.js";

let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "codev-modelapp-test-"));
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
});

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempHome, { recursive: true, force: true });
});

function tick(ms = 50): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

// Poll `frames` for a substring with a 30ms settle after match so the
// just-mounted component's useInput is active before the next keypress.
// Avoids the fixed-time `tick(150)` waits which are too tight on Windows CI.
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

describe("ModelApp", () => {
	test("errors out when no saved creds are present", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(null);
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
		]);

		// exit() unmounts before lastFrame can read; inspect frame history.
		const { frames } = render(<ModelApp />);
		await tick();
		expect(allFrames(frames)).toContain("No CoDev credentials found");
	});

	test("errors out when no CoDev-configured tools are present", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-1",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([]);

		const { frames } = render(<ModelApp />);
		await tick();
		expect(allFrames(frames)).toContain("No CoDev-configured AI tools found");
	});

	test("happy SSO path: valid key → list → pick first → configure each tool → save", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-existing",
			model: "old-model",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
			"opencode",
		]);
		vi.spyOn(proxy, "fetchModels").mockResolvedValue(["new-alpha", "new-beta"]);
		const configureClaude = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: false,
				},
			]);
		const configureOpen = vi
			.spyOn(configure, "configureOpenCode")
			.mockReturnValue([
				{
					kind: "opencode-config",
					sourcePath: "/tmp/y",
					backupPath: "/tmp/y.b",
					created: false,
				},
			]);
		const saveSpy = vi.spyOn(auth, "saveApiKey");

		const { stdin, frames } = render(<ModelApp />);
		// Wait for the model row itself — "Choose default model" appears while
		// the spinner is still up and useInput isn't bound yet, so a fixed
		// tick(150) lands the Enter press before the handler is active on
		// slow CI runners.
		await waitForFrame(frames, "○ new-alpha");
		// Enter on default cursor (first row).
		stdin.write("\r");
		await waitForFrame(frames, "Default model updated to");

		const history = allFrames(frames);
		// Two-tool list uses "and", not a comma.
		expect(history).toContain(
			"Default model updated to new-alpha for Claude Code and OpenCode.",
		);
		expect(configureClaude).toHaveBeenCalledWith({
			apiKey: "sk-existing",
			baseUrl: undefined,
			model: "new-alpha",
			models: ["new-alpha", "new-beta"],
		});
		expect(configureOpen).toHaveBeenCalledWith({
			apiKey: "sk-existing",
			baseUrl: undefined,
			model: "new-alpha",
			models: ["new-alpha", "new-beta"],
		});
		// Codex was not detected, so it must not be reconfigured.
		expect(configureClaude).toHaveBeenCalledTimes(1);
		// Final saveApiKey persists the new model.
		expect(saveSpy).toHaveBeenLastCalledWith({
			apiKey: "sk-existing",
			baseUrl: undefined,
			model: "new-alpha",
		});
	});

	test("invalid-key (manual install with baseUrl) drops into ManualCredentials", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-bad",
			baseUrl: "https://my-gw.example.com/v1",
			model: "old",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
		]);
		// First fetch: 401. Second fetch (after manual re-auth): success.
		vi.spyOn(proxy, "fetchModels")
			.mockRejectedValueOnce(
				new Error("Models fetch failed (401): invalid key"),
			)
			.mockResolvedValueOnce(["m1", "m2"]);
		const configureClaude = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: false,
				},
			]);

		const { stdin, frames } = render(<ModelApp />);
		// Wait for fetching → 401 → re-auth-manual
		await waitForFrame(frames, "Enter API credentials");
		expect(allFrames(frames)).toContain("Enter API credentials");
		expect(allFrames(frames)).toContain("Saved API key was rejected");

		// Type new baseUrl + apiKey.
		stdin.write("https://new-gw.example.com/v1");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("sk-new");
		await tick();
		stdin.write("\r");
		// Wait for the model row itself — "Choose default model" appears before
		// fetchModels resolves (during the "Fetching available models..." spinner
		// state), at which point ModelSelect's useInput isn't bound yet and an
		// Enter press would be dropped.
		await waitForFrame(frames, "○ m1");

		// Now in model-choice with the new list. Press Enter for default cursor.
		expect(allFrames(frames)).toContain("Choose default model");
		stdin.write("\r");
		await waitForFrame(frames, "Default model updated to");

		expect(allFrames(frames)).toContain("Default model updated to");
		expect(configureClaude).toHaveBeenCalledWith({
			apiKey: "sk-new",
			baseUrl: "https://new-gw.example.com/v1",
			model: "m1",
			models: ["m1", "m2"],
		});
	});

	test("invalid-key (SSO install, no baseUrl) drops into Login", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-bad",
			model: "old",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
		]);
		vi.spyOn(proxy, "fetchModels").mockRejectedValueOnce(
			new Error("Models fetch failed (401): invalid key"),
		);

		const { frames } = render(<ModelApp />);
		await waitForFrame(frames, "Saved API key was rejected");
		// We don't drive Login here (it would actually try to login() against
		// the proxy). Just assert the SSO branch was taken.
		expect(allFrames(frames)).toContain("Login");
		expect(allFrames(frames)).toContain("Saved API key was rejected");
	});

	test("re-auth that produces another invalid key gives up (no infinite loop)", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-bad",
			baseUrl: "https://my-gw.example.com/v1",
			model: "old",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
		]);
		// Both fetch attempts return 401.
		vi.spyOn(proxy, "fetchModels").mockRejectedValue(
			new Error("Models fetch failed (401): invalid key"),
		);

		const { stdin, frames } = render(<ModelApp />);
		await waitForFrame(frames, "Enter API credentials");

		// Drive ManualCredentials with new (but still 'invalid') creds.
		stdin.write("https://retry.example.com/v1");
		await tick();
		stdin.write("\r");
		await tick();
		stdin.write("sk-also-bad");
		await tick();
		stdin.write("\r");
		await waitForFrame(frames, "Re-authentication did not produce a valid key");

		expect(allFrames(frames)).toContain(
			"Re-authentication did not produce a valid key",
		);
	});

	test("non-auth fetch failure shows the retry prompt instead of routing to re-auth", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-x",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
		]);
		const fetchSpy = vi
			.spyOn(proxy, "fetchModels")
			.mockRejectedValue(
				new Error("Models fetch failed (503): Service Unavailable"),
			);

		const { frames } = render(<ModelApp />);
		await waitForFrame(frames, "Press Enter to retry");

		const history = allFrames(frames);
		expect(history).toContain("503");
		expect(history).toContain("Failed to fetch models");
		// Should not have entered any re-auth branch — a 503 is not an auth error.
		expect(history).not.toContain("Saved API key was rejected");
		// One attempt so far; ModelSelect leaves the choice to the user.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("non-auth fetch failure recovers when the user retries", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			apiKey: "sk-x",
		});
		vi.spyOn(configure, "detectConfiguredTools").mockReturnValue([
			"claude-code",
		]);
		const fetchSpy = vi
			.spyOn(proxy, "fetchModels")
			.mockRejectedValueOnce(
				new Error("Models fetch failed (503): Service Unavailable"),
			)
			.mockResolvedValue(["recovered-alpha", "recovered-beta"]);
		const configureClaude = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([
				{
					kind: "claude-settings",
					sourcePath: "/tmp/x",
					backupPath: "/tmp/x.b",
					created: false,
				},
			]);

		const { stdin, frames } = render(<ModelApp />);
		await waitForFrame(frames, "Press Enter to retry");
		stdin.write("\r");
		await waitForFrame(frames, "○ recovered-alpha");
		stdin.write("\r");
		await waitForFrame(frames, "Default model updated to");

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(configureClaude).toHaveBeenCalledWith({
			apiKey: "sk-x",
			baseUrl: undefined,
			model: "recovered-alpha",
			models: ["recovered-alpha", "recovered-beta"],
		});
	});
});
