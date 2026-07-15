import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runClearLogs } from "@/lib/clear-logs.js";
import { agentLogsDir, cliLogsDir } from "@/lib/paths.js";

let tempHome: string;
let logSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "codev-clear-logs-"));
	// homedir() reads USERPROFILE on Windows, HOME on POSIX — stub both.
	vi.stubEnv("HOME", tempHome);
	vi.stubEnv("USERPROFILE", tempHome);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	logSpy.mockRestore();
	errSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
});

function seed(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "sample.txt"), "x");
}

describe("runClearLogs", () => {
	test("removes both log homes when present", () => {
		seed(cliLogsDir());
		seed(agentLogsDir());

		expect(runClearLogs()).toBe(0);
		expect(existsSync(cliLogsDir())).toBe(false);
		expect(existsSync(agentLogsDir())).toBe(false);
	});

	test("skips a missing dir without failing, removes the one present", () => {
		seed(agentLogsDir()); // only exports exist

		expect(runClearLogs()).toBe(0);
		expect(existsSync(agentLogsDir())).toBe(false);
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("Skipped diagnostic logs");
		expect(output).toContain("Removed conversation exports");
	});

	test("succeeds and reports nothing to remove when neither dir exists", () => {
		expect(runClearLogs()).toBe(0);
		const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(output).toContain("Nothing to remove.");
	});
});
