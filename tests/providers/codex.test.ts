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
import { codexProvider } from "@/providers/codex.js";

let tempHome: string;
let projectCwd: string;
let dayDir: string;

function writeSession(name: string, lines: object[]): void {
	const body = lines.map((l) => JSON.stringify(l)).join("\n");
	writeFileSync(join(dayDir, name), body);
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-codex-")));
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	dayDir = join(tempHome, ".codex", "sessions", "2026", "04", "27");
	mkdirSync(dayDir, { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("codexProvider.detect", () => {
	test("returns true when at least one session has a matching cwd", async () => {
		writeSession("session-1.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-1",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: projectCwd,
				},
			},
		]);
		expect(await codexProvider.detect(projectCwd)).toBe(true);
	});

	test("returns false when no sessions match cwd", async () => {
		const otherCwd = join(tempHome, "other");
		mkdirSync(otherCwd, { recursive: true });
		writeSession("session-1.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-1",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: otherCwd,
				},
			},
		]);
		expect(await codexProvider.detect(projectCwd)).toBe(false);
	});

	test("returns false when sessions root does not exist", async () => {
		rmSync(join(tempHome, ".codex"), { recursive: true, force: true });
		expect(await codexProvider.detect(projectCwd)).toBe(false);
	});
});

describe("codexProvider.listSessions", () => {
	test("parses user_message and agent_message events for matching cwd", async () => {
		writeSession("session-1.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-1",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: projectCwd,
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:10Z",
				payload: { type: "user_message", message: "Refactor the auth module" },
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:20Z",
				payload: { type: "agent_reasoning", text: "Thinking..." },
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:30Z",
				payload: { type: "agent_message", message: "I'll start with auth.ts" },
			},
		]);

		const sessions = await codexProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected one session");
		expect(s.id).toBe("ses-1");
		expect(s.agent).toBe("codex");
		expect(s.firstUserMessage).toBe("Refactor the auth module");
		expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(s.messages[1]?.content).toBe(
			"<details><summary>Thought</summary>\n\nThinking...\n</details>\nI'll start with auth.ts",
		);
	});

	test("parses tool calls and tool outputs in Codex sessions", async () => {
		writeSession("session-tool.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-tool",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: projectCwd,
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:10Z",
				payload: { type: "user_message", message: "Run the tests" },
			},
			{
				type: "response_item",
				timestamp: "2026-04-27T18:32:20Z",
				payload: {
					type: "function_call",
					name: "exec_command",
					arguments: '{"cmd":"npm run test"}',
					call_id: "c-tool-1",
				},
			},
			{
				type: "response_item",
				timestamp: "2026-04-27T18:32:25Z",
				payload: {
					type: "function_call_output",
					call_id: "c-tool-1",
					output: "Output:\nAll tests passed!",
					is_error: false,
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:30Z",
				payload: { type: "agent_message", message: "Done!" },
			},
		]);

		const sessions = await codexProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected session");
		expect(s.messages.length).toBe(2);
		const assistantContent = s.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="shell" data-tool-name="exec_command">',
		);
		expect(assistantContent).toContain("npm run test");
		expect(assistantContent).toContain("All tests passed!");
		expect(assistantContent).toContain("Done!");
	});

	test("parses apply_patch custom tool calls as write diffs", async () => {
		writeSession("session-patch.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-patch",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: projectCwd,
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:10Z",
				payload: { type: "user_message", message: "Patch random.ts" },
			},
			{
				type: "response_item",
				timestamp: "2026-04-27T18:32:20Z",
				payload: {
					type: "custom_tool_call",
					name: "apply_patch",
					input:
						"*** Begin Patch\n*** Update File: /tmp/random.ts\n@@\n-old line\n+new line\n+another line\n*** End Patch\n",
					call_id: "patch-1",
				},
			},
			{
				type: "response_item",
				timestamp: "2026-04-27T18:32:25Z",
				payload: {
					type: "custom_tool_call_output",
					call_id: "patch-1",
					output: "Success. Updated the following files:\nM /tmp/random.ts\n",
					is_error: false,
				},
			},
		]);

		const sessions = await codexProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected session");
		const assistantContent = s.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="apply_patch" data-edit-status="accepted">',
		);
		expect(assistantContent).toContain(
			"<summary>Edit file: /tmp/random.ts</summary>",
		);
		expect(assistantContent).toContain("```diff\n*** Begin Patch");
		expect(assistantContent).toContain("-old line");
		expect(assistantContent).toContain("+new line");
		expect(assistantContent).toContain("Success. Updated the following files");
	});

	test("keeps rejected apply_patch custom tool calls as rejected diffs", async () => {
		writeSession("session-rejected-patch.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-rejected-patch",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: projectCwd,
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:10Z",
				payload: { type: "user_message", message: "Patch random.ts" },
			},
			{
				type: "response_item",
				timestamp: "2026-04-27T18:32:20Z",
				payload: {
					type: "custom_tool_call",
					name: "apply_patch",
					input:
						"*** Begin Patch\n*** Update File: /tmp/random.ts\n@@\n-old line\n+new line\n*** End Patch\n",
					call_id: "patch-1",
				},
			},
			{
				type: "response_item",
				timestamp: "2026-04-27T18:32:25Z",
				payload: {
					type: "custom_tool_call_output",
					call_id: "patch-1",
					output: "The user rejected this edit.",
					is_error: true,
				},
			},
		]);

		const sessions = await codexProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="apply_patch" data-edit-status="rejected">',
		);
		expect(assistantContent).toContain("```diff\n*** Begin Patch");
		expect(assistantContent).toContain("-old line");
		expect(assistantContent).toContain("+new line");
		expect(assistantContent).toContain("Error: The user rejected this edit.");
	});

	test("excludes sessions whose cwd does not match", async () => {
		const otherCwd = join(tempHome, "elsewhere");
		mkdirSync(otherCwd, { recursive: true });
		writeSession("session-1.jsonl", [
			{
				type: "session_meta",
				timestamp: "2026-04-27T18:32:05Z",
				payload: {
					id: "ses-elsewhere",
					timestamp: "2026-04-27T18:32:05Z",
					cwd: otherCwd,
				},
			},
			{
				type: "event_msg",
				timestamp: "2026-04-27T18:32:10Z",
				payload: { type: "user_message", message: "Hi" },
			},
		]);

		const sessions = await codexProvider.listSessions(projectCwd);
		expect(sessions).toEqual([]);
	});
});
