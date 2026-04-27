import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "@/export.js";

let tempHome: string;
let projectCwd: string;
let homedirSpy: ReturnType<typeof spyOn>;
let cwdSpy: ReturnType<typeof spyOn>;

function mungeCwd(cwd: string): string {
	const dashed = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
	return dashed.startsWith("-") ? dashed : `-${dashed}`;
}

function seedClaudeSession(): void {
	const claudeDir = join(
		tempHome,
		".claude",
		"projects",
		mungeCwd(realpathSync(projectCwd)),
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
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	cwdSpy = spyOn(process, "cwd").mockReturnValue(projectCwd);
});

afterEach(() => {
	homedirSpy.mockRestore();
	cwdSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("runExport", () => {
	test("writes markdown to ~/.codev/logs/<project>/ and returns a summary", async () => {
		seedClaudeSession();
		const summary = await runExport();
		const expectedDir = join(tempHome, ".codev", "logs", "works-myapp");
		expect(summary.outDir).toBe(expectedDir);
		expect(summary.exported).toBe(1);
		expect(summary.byAgent["claude-code"]).toBe(1);
		expect(summary.skipped).toContain("codex");
		expect(summary.skipped).toContain("opencode");

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
			"logs",
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
		expect(summary.skipped).toEqual(["claude-code", "codex", "opencode"]);
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
	});
});
