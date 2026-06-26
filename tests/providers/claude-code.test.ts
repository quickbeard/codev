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
import {
	claudeCodeProvider,
	claudeProjectDirName,
} from "@/providers/claude-code.js";

let tempHome: string;
let projectCwd: string;
let claudeProjectDir: string;

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
		claudeProjectDirName(realpathSync(projectCwd)),
	);
	mkdirSync(claudeProjectDir, { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("claudeProjectDirName", () => {
	test("encodes a POSIX path with a leading dash from the root slash", () => {
		expect(claudeProjectDirName("/Users/minh/works/repos/codev")).toBe(
			"-Users-minh-works-repos-codev",
		);
	});

	// Regression: a Windows drive-letter path has no leading separator, so the
	// folder name must start with the drive letter — matching what Claude Code
	// actually writes (`E--QUANPV2-...`). The old logic prepended a stray dash
	// (`-E--QUANPV2-...`), which made detect() miss every Windows project.
	test("encodes a Windows drive-letter path with no leading dash", () => {
		expect(
			claudeProjectDirName(
				"E:\\QUANPV2\\GITLAB_NEW\\vmp\\vmp_integration\\vmp-email-service",
			),
		).toBe("E--QUANPV2-GITLAB-NEW-vmp-vmp-integration-vmp-email-service");
	});

	// Unicode word characters (Vietnamese diacritics here) are stripped to
	// dashes, exactly as Claude Code's own `[^a-zA-Z0-9]` munge does — verified
	// against the Claude Code binary. We must NOT preserve them: a
	// Unicode-preserving name would not match the folder Claude writes on disk.
	test("strips non-ASCII characters to dashes, matching Claude Code", () => {
		expect(
			claudeProjectDirName("D:\\Viettel\\Đánh giá Quý II_2026\\Gỡ băng"),
		).toBe("D--Viettel---nh-gi--Qu--II-2026-G--b-ng");
	});

	// Claude caps the folder name at 200 chars: longer munges are truncated to
	// 200 and suffixed with `-<base36 Java-hash of the original path>`. The hash
	// (`4u7n1z`) is the exact value Claude Code's binary produces for this input.
	test("truncates a >200-char munge to 200 chars plus a hash suffix", () => {
		const cwd = `/Users/minh/${Array.from(
			{ length: 30 },
			(_, i) => `segment_number_${i}`,
		).join("/")}`;
		const out = claudeProjectDirName(cwd);
		// 200-char prefix + "-" + 6-char base36 hash.
		expect(out.length).toBe(207);
		expect(out.endsWith("-4u7n1z")).toBe(true);
		expect(out.slice(0, 200)).toBe(
			cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200),
		);
	});

	// A munge of exactly the cap is left untouched — no spurious hash suffix.
	test("does not truncate or hash a name at the 200-char boundary", () => {
		const cwd = `/${"a".repeat(199)}`; // munges to "-" + 199 a's = 200 chars
		const out = claudeProjectDirName(cwd);
		expect(out.length).toBe(200);
		expect(out).toBe(`-${"a".repeat(199)}`);
	});
});

describe("claudeCodeProvider.describeTarget", () => {
	test("reports the project session dir detect() looks for", () => {
		expect(claudeCodeProvider.describeTarget(projectCwd)).toBe(
			claudeProjectDir,
		);
	});

	// The whole point of surfacing the target: when a Windows user's upload finds
	// nothing, the inactive log shows the exact munged folder so the path can be
	// compared against what's on disk.
	test("reports the munged folder for a non-existent cwd without throwing", () => {
		const cwd = join(tempHome, "never", "created");
		expect(claudeCodeProvider.describeTarget(cwd)).toBe(
			join(tempHome, ".claude", "projects", claudeProjectDirName(cwd)),
		);
	});
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

	test("renders Write (file creation) content as an all-additions diff", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Create random.ts" },
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
							id: "t-write",
							name: "Write",
							input: {
								file_path: "/tmp/random.ts",
								content:
									"// Test file\nexport function generateRandomId(): string {\n  return Math.random().toString(36);\n}",
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
							tool_use_id: "t-write",
							content: "File created successfully at: /tmp/random.ts",
						},
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="accepted">',
		);
		// Whole-file content rendered inside a ```diff fence with every line as a
		// `+` addition — this is what lets the LOC enricher count file creations.
		expect(assistantContent).toContain("```diff");
		expect(assistantContent).toContain("+// Test file");
		expect(assistantContent).toContain(
			"+export function generateRandomId(): string {",
		);
		expect(assistantContent).toContain("File created successfully");
	});

	test("keeps rejected Write (file creation) content as a rejected diff", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Create random.ts" },
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
							id: "t-write-reject",
							name: "Write",
							input: {
								file_path: "/tmp/random.ts",
								content: "const a = 1;\nconst b = 2;\nconst c = 3;",
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
							tool_use_id: "t-write-reject",
							is_error: true,
							content: "The user doesn't want to proceed with this tool use.",
						},
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="rejected">',
		);
		// Content must survive rejection so proposed/rejected LOC are still counted.
		expect(assistantContent).toContain("```diff");
		expect(assistantContent).toContain("+const a = 1;");
		expect(assistantContent).toContain("+const c = 3;");
		expect(assistantContent).toContain(
			"Error: The user doesn't want to proceed",
		);
	});

	test("returns empty list when the project dir contains no jsonl files", async () => {
		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions).toEqual([]);
	});

	test("folds isSidechain turns into subagentChars without rendering them", async () => {
		// The parent session has one user prompt and one Task spawn (inline).
		// The subagent's own turns are written to the same file flagged with
		// isSidechain — they must not appear in the exported transcript, but
		// their character volume is rolled into subagentChars*.
		const sessionId = "abcdefab-1234-5678-9abc-def012345678";
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:00Z",
				sessionId,
				message: { role: "user", content: "Explore the codebase" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId,
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t-task",
							name: "Task",
							input: { description: "Find files", prompt: "List all ts files" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:10Z",
				sessionId,
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t-task",
							text: "src/index.ts",
						},
					],
				},
			}),
			// Sidechain records — the subagent's own conversation. Must be skipped.
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:06Z",
				sessionId,
				isSidechain: true,
				message: { role: "user", content: "List all ts files" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:09Z",
				sessionId,
				isSidechain: true,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Found: src/index.ts" }],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected one session");
		// Only the parent's two messages (user prompt + assistant with Task spawn).
		expect(s.messages.length).toBe(2);
		expect(s.messages[0]?.content).toBe("Explore the codebase");
		// Task tool-use rendered inline in the parent.
		expect(s.messages[1]?.content).toContain(
			'data-tool-type="task" data-tool-name="task"',
		);
		expect(s.messages[1]?.content).toContain("src/index.ts");
		// Subagent's own text must not leak into the parent body...
		expect(s.messages[1]?.content).not.toContain("Found: src/index.ts");
		// ...but its character volume is rolled into subagentChars* (matching the
		// OpenCode descendant rollup) so the parent reflects the subagent's cost.
		expect(s.subagentCharsIn).toBe("List all ts files".length);
		expect(s.subagentCharsOut).toBe("Found: src/index.ts".length);
	});

	test('marks orphan tool_use as data-edit-status="aborted", not rejected', async () => {
		// Session ends with a tool_use that never received a tool_result —
		// the kind of interruption an analytics consumer must NOT count as
		// a user rejection.
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
							id: "t-orphan",
							name: "Edit",
							input: {
								file_path: "/tmp/random.ts",
								old_string: "x",
								new_string: "y",
							},
						},
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain('data-edit-status="aborted"');
		expect(assistantContent).not.toContain('data-edit-status="rejected"');
	});

	test("renders mixed tool_result + text user content as both tool output and a user turn", async () => {
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:00Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "Read foo.ts" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t-mix",
							name: "Read",
							input: { file_path: "/tmp/foo.ts" },
						},
					],
				},
			}),
			// Single user record with BOTH tool_result and a fresh user text.
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:10Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t-mix",
							text: "export const foo = 1;",
						},
						{ type: "text", text: "Now rename it to bar." },
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		const session = sessions[0];
		if (!session) throw new Error("expected one session");
		// Three messages: user prompt, assistant turn (with tool_use rendered),
		// then a new user turn from the trailing text block.
		expect(session.messages.length).toBe(3);
		expect(session.messages[2]?.role).toBe("user");
		expect(session.messages[2]?.content).toContain("Now rename it to bar.");
		expect(session.messages[1]?.content).toContain("export const foo = 1;");
	});

	test("wraps tool output in a long-enough fence when it contains triple backticks", async () => {
		// The output contains a literal ``` — naive ```bash wrapping would
		// terminate the fence early. codeFence must pick a longer fence.
		const tripleBacktickOutput = "before ``` after";
		const lines = [
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:00Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: { role: "user", content: "run something" },
			}),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-04-27T18:32:05Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t-fence",
							name: "Bash",
							input: { command: "echo hi" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "user",
				timestamp: "2026-04-27T18:32:10Z",
				sessionId: "abcdefab-1234-5678-9abc-def012345678",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t-fence",
							text: tripleBacktickOutput,
						},
					],
				},
			}),
		];
		writeFileSync(join(claudeProjectDir, "session.jsonl"), lines.join("\n"));

		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain("````bash");
		expect(assistantContent).toContain(tripleBacktickOutput);
	});
});
