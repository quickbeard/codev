import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claudeCodeProvider } from "@/providers/claude-code.js";

let tempHome: string;
let projectCwd: string;
let claudeProjectDir: string;

function mungeCwd(cwd: string): string {
	const dashed = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
	return dashed.startsWith("-") ? dashed : `-${dashed}`;
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-claude-")));
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	claudeProjectDir = join(
		tempHome,
		".claude",
		"projects",
		mungeCwd(realpathSync(projectCwd)),
	);
	mkdirSync(claudeProjectDir, { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("claudeCodeProvider.detect", () => {
	test("returns true when the project directory exists", async () => {
		expect(await claudeCodeProvider.detect(projectCwd)).toBe(true);
	});

	test("returns false when no project directory exists for cwd", async () => {
		const otherCwd = join(tempHome, "other");
		mkdirSync(otherCwd, { recursive: true });
		expect(await claudeCodeProvider.detect(otherCwd)).toBe(false);
	});
});

describe("claudeCodeProvider.listSessions", () => {
	test("parses a single-line user/assistant session", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Help me fix the login bug" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:30Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Sure — show me auth.ts" }],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected one session");
		expect(s.id).toBe("abcdefab-1234-5678-9abc-def012345678");
		expect(s.agent).toBe("claude-code");
		expect(s.firstUserMessage).toBe("Help me fix the login bug");
		expect(s.messages.length).toBe(2);
		expect(s.messages[0]?.role).toBe("user");
		expect(s.messages[1]?.role).toBe("assistant");
		expect(s.messages[1]?.content).toBe("Sure — show me auth.ts");
	});

	test("ignores tool-result user records (they're internal turns)", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Read foo.ts" },
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:15Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "user",
					content: [{ type: "tool_result", text: "file contents" }],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions[0]?.messages.length).toBe(1);
		expect(sessions[0]?.messages[0]?.content).toBe("Read foo.ts");
	});

	test("parses thinking and tool_use blocks", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Optimize auth" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:10Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Checking files..." },
						{
							type: "tool_use",
							id: "t-1",
							name: "view_file",
							input: { path: "auth.ts" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:15Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t-1",
							text: "export const login = () => {}",
						},
					],
				},
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:20Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: "Done!",
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected one session");
		expect(s.messages.length).toBe(2);
		expect(s.messages[0]?.role).toBe("user");
		expect(s.messages[1]?.role).toBe("assistant");
		const assistantContent = s.messages[1]?.content || "";
		expect(assistantContent).toContain("<details><summary>Thought</summary>");
		expect(assistantContent).toContain("Checking files...");
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="read" data-tool-name="view_file">',
		);
		expect(assistantContent).toContain("export const login");
		expect(assistantContent).toContain("Done!");
	});

	test("exports Claude Code edit old/new strings as diff blocks", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Edit random.ts" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:10Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t-edit",
							name: "Edit",
							input: {
								file_path: "/tmp/random.ts",
								old_string:
									"function randomBool(): boolean {\n  return Math.random() > 0.3;\n}",
								new_string:
									"function randomBool(): boolean {\n  return Math.random() > 0.5;\n}\n\nfunction randomDate(): Date {\n  return new Date();\n}",
							},
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:15Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t-edit",
							content: "The file /tmp/random.ts has been updated successfully.",
						},
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="accepted">',
		);
		expect(assistantContent).toContain(
			"<summary>Edit file: /tmp/random.ts</summary>",
		);
		expect(assistantContent).toContain("```diff");
		expect(assistantContent).toContain("-  return Math.random() > 0.3;");
		expect(assistantContent).toContain("+  return Math.random() > 0.5;");
		expect(assistantContent).toContain("+function randomDate(): Date {");
		expect(assistantContent).toContain("has been updated successfully");
	});

	test("keeps rejected edit proposals as rejected diff blocks", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Edit random.ts" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:10Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t-reject",
							name: "Edit",
							input: {
								file_path: "/tmp/random.ts",
								old_string: "const lucky = false;",
								new_string: "const lucky = true;",
							},
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:15Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t-reject",
							is_error: true,
							content: "The user rejected this edit.",
						},
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="rejected">',
		);
		expect(assistantContent).toContain("```diff");
		expect(assistantContent).toContain("-const lucky = false;");
		expect(assistantContent).toContain("+const lucky = true;");
		expect(assistantContent).toContain("Error: The user rejected this edit.");
	});

	test("returns empty list when the project dir contains no jsonl files", async () => {
		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions).toEqual([]);
	});
});
