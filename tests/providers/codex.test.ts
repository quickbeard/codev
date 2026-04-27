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
import { codexProvider } from "@/providers/codex.js";

let tempHome: string;
let homedirSpy: ReturnType<typeof spyOn>;
let projectCwd: string;
let dayDir: string;

function writeSession(name: string, lines: object[]): void {
	const body = lines.map((l) => JSON.stringify(l)).join("\n");
	writeFileSync(join(dayDir, name), body);
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-codex-")));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	dayDir = join(tempHome, ".codex", "sessions", "2026", "04", "27");
	mkdirSync(dayDir, { recursive: true });
});

afterEach(() => {
	homedirSpy.mockRestore();
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
		// Reasoning events are intentionally dropped — only user/agent messages remain.
		expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(s.messages[1]?.content).toBe("I'll start with auth.ts");
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
