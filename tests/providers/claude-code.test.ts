import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeProvider } from "@/providers/claude-code.js";

let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;
let projectCwd: string;
let claudeProjectDir: string;

function mungeCwd(cwd: string): string {
	const dashed = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
	return dashed.startsWith("-") ? dashed : `-${dashed}`;
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-claude-")));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
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
	homedirSpy.mockRestore();
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

	test("returns empty list when the project dir contains no jsonl files", async () => {
		const sessions = await claudeCodeProvider.listSessions(projectCwd);
		expect(sessions).toEqual([]);
	});
});
