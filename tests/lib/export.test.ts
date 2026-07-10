import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { migrateLegacyAgentLogs, runExport } from "@/lib/export.js";
import { claudeProjectDirName } from "@/providers/claude-code.js";

let tempHome: string;
let projectCwd: string;
let cwdSpy: MockInstance;

function seedClaudeSession(): void {
	const claudeDir = join(
		tempHome,
		".claude",
		"projects",
		claudeProjectDirName(realpathSync(projectCwd)),
	);
	mkdirSync(claudeDir, { recursive: true });
	const lines = [
		JSON.stringify({
			type: "user",
			timestamp: "2026-04-27T18:32:05Z",
			sessionId: "abcdefab-1234-5678-9abc-def012345678",
			message: { role: "user", content: "Help me refactor auth" },
		}),
		JSON.stringify({
			type: "assistant",
			timestamp: "2026-04-27T18:32:30Z",
			sessionId: "abcdefab-1234-5678-9abc-def012345678",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "OK — show me auth.ts" }],
			},
		}),
	];
	writeFileSync(join(claudeDir, "session.jsonl"), lines.join("\n"));
}

function seedCodexSession(): void {
	const dayDir = join(tempHome, ".codex", "sessions", "2026", "04", "27");
	mkdirSync(dayDir, { recursive: true });
	const lines = [
		JSON.stringify({
			type: "session_meta",
			timestamp: "2026-04-27T19:15:22Z",
			payload: {
				id: "codex-session-1",
				timestamp: "2026-04-27T19:15:22Z",
				cwd: projectCwd,
			},
		}),
		JSON.stringify({
			type: "event_msg",
			timestamp: "2026-04-27T19:15:30Z",
			payload: { type: "user_message", message: "Explain the build pipeline" },
		}),
		JSON.stringify({
			type: "event_msg",
			timestamp: "2026-04-27T19:15:40Z",
			payload: { type: "agent_message", message: "Sure — start at build.ts" },
		}),
	];
	writeFileSync(join(dayDir, "codex-session-1.jsonl"), lines.join("\n"));
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-export-")));
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectCwd);
});

afterEach(() => {
	vi.unstubAllEnvs();
	cwdSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("runExport", () => {
	test("writes markdown to ~/.codev/agent-logs/<project>/ and returns a summary", async () => {
		seedClaudeSession();
		const summary = await runExport();
		const expectedDir = join(tempHome, ".codev", "agent-logs", "works-myapp");
		expect(summary.outDir).toBe(expectedDir);
		expect(summary.exported).toBe(1);
		expect(summary.byAgent["claude-code"]).toBe(1);
		expect(summary.skipped).toContain("codex");
		expect(summary.skipped).toContain("opencode");
		expect(summary.skipped).toContain("codev-code");

		const expectedFile = join(
			expectedDir,
			"claude-code",
			"2026-04-27_18-32-05Z-help-me-refactor-auth.md",
		);
		expect(existsSync(expectedFile)).toBe(true);
		const md = readFileSync(expectedFile, "utf8");
		expect(md).toContain("Help me refactor auth");
		expect(md).toContain("OK — show me auth.ts");
	});

	test("writes statistics.json with one entry per session", async () => {
		seedClaudeSession();
		await runExport();
		const statsPath = join(
			tempHome,
			".codev",
			"agent-logs",
			"works-myapp",
			"statistics.json",
		);
		expect(existsSync(statsPath)).toBe(true);
		const file = JSON.parse(readFileSync(statsPath, "utf8"));
		expect(file.sessions["abcdefab-1234-5678-9abc-def012345678"].provider).toBe(
			"claude-code",
		);
	});

	test("skips all providers when no agents are active", async () => {
		const summary = await runExport();
		expect(summary.exported).toBe(0);
		expect(summary.skipped).toEqual([
			"claude-code",
			"codex",
			"opencode",
			"codev-code",
		]);
		// Each skipped provider records where it looked, so `codevhub upload` can
		// explain an empty result instead of a bare "0/0".
		expect(summary.targets.map((t) => t.agent)).toEqual([
			"claude-code",
			"codex",
			"opencode",
			"codev-code",
		]);
		expect(summary.targets.every((t) => t.path.length > 0)).toBe(true);
	});

	test("calls the status reporter with progress messages", async () => {
		seedClaudeSession();
		const messages: string[] = [];
		await runExport((msg) => messages.push(msg));
		expect(messages.some((m) => m.includes("claude-code"))).toBe(true);
	});

	test("writes each agent's sessions into its own subfolder", async () => {
		seedClaudeSession();
		seedCodexSession();
		const summary = await runExport();
		const claudeDir = join(summary.outDir, "claude-code");
		const codexDir = join(summary.outDir, "codex");
		expect(existsSync(claudeDir)).toBe(true);
		expect(existsSync(codexDir)).toBe(true);
		expect(
			existsSync(
				join(claudeDir, "2026-04-27_18-32-05Z-help-me-refactor-auth.md"),
			),
		).toBe(true);
		expect(
			existsSync(
				join(codexDir, "2026-04-27_19-15-22Z-explain-the-build-pipeline.md"),
			),
		).toBe(true);
		// statistics.json sits at the project root, not inside any agent folder.
		expect(existsSync(join(summary.outDir, "statistics.json"))).toBe(true);
		expect(existsSync(join(claudeDir, "statistics.json"))).toBe(false);
	});

	test("does not create an agent subfolder for a provider with no activity", async () => {
		seedClaudeSession();
		const summary = await runExport();
		expect(existsSync(join(summary.outDir, "claude-code"))).toBe(true);
		expect(existsSync(join(summary.outDir, "codex"))).toBe(false);
		expect(existsSync(join(summary.outDir, "opencode"))).toBe(false);
		expect(existsSync(join(summary.outDir, "codev-code"))).toBe(false);
	});
});

describe("migrateLegacyAgentLogs", () => {
	const legacyRoot = () => join(tempHome, ".codev", "logs");
	const targetRoot = () => join(tempHome, ".codev", "agent-logs");

	test("moves legacy project folders into ~/.codev/agent-logs/", () => {
		const legacyFile = join(legacyRoot(), "works-myapp", "codex", "a.md");
		mkdirSync(join(legacyRoot(), "works-myapp", "codex"), { recursive: true });
		writeFileSync(legacyFile, "hello");

		migrateLegacyAgentLogs();

		expect(existsSync(join(targetRoot(), "works-myapp", "codex", "a.md"))).toBe(
			true,
		);
		expect(existsSync(join(legacyRoot(), "works-myapp"))).toBe(false);
	});

	test("leaves diagnostic ndjson files at the legacy root in place", () => {
		mkdirSync(join(legacyRoot(), "works-myapp"), { recursive: true });
		const diagFile = join(legacyRoot(), "codev-20260610.ndjson");
		writeFileSync(diagFile, "{}\n");

		migrateLegacyAgentLogs();

		expect(existsSync(diagFile)).toBe(true);
		expect(existsSync(join(targetRoot(), "works-myapp"))).toBe(true);
	});

	test("keeps the destination copy when a project folder exists at both roots", () => {
		mkdirSync(join(legacyRoot(), "works-myapp"), { recursive: true });
		writeFileSync(join(legacyRoot(), "works-myapp", "old.md"), "old");
		mkdirSync(join(targetRoot(), "works-myapp"), { recursive: true });
		writeFileSync(join(targetRoot(), "works-myapp", "new.md"), "new");

		migrateLegacyAgentLogs();

		expect(existsSync(join(targetRoot(), "works-myapp", "new.md"))).toBe(true);
		expect(existsSync(join(targetRoot(), "works-myapp", "old.md"))).toBe(false);
		expect(existsSync(join(legacyRoot(), "works-myapp", "old.md"))).toBe(true);
	});

	test("is a no-op when no legacy dir exists", () => {
		expect(() => migrateLegacyAgentLogs()).not.toThrow();
		expect(existsSync(targetRoot())).toBe(false);
	});

	test("runExport relocates legacy exports before writing new ones", async () => {
		mkdirSync(join(legacyRoot(), "old-project", "codex"), { recursive: true });
		writeFileSync(join(legacyRoot(), "old-project", "codex", "a.md"), "x");
		seedClaudeSession();

		const summary = await runExport();

		expect(summary.outDir).toBe(join(targetRoot(), "works-myapp"));
		expect(existsSync(join(targetRoot(), "old-project", "codex", "a.md"))).toBe(
			true,
		);
	});
});
