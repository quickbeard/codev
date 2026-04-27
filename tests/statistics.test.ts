import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@/providers/types.js";
import { computeSessionStatistics, StatisticsCollector } from "@/statistics.js";

let tempDir: string;
let statsPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-stats-"));
	statsPath = join(tempDir, "statistics.json");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function fixture(overrides: Partial<Session> = {}): Session {
	return {
		id: "session-1",
		agent: "claude-code",
		createdAt: new Date(Date.UTC(2026, 3, 27, 18, 32, 5)),
		updatedAt: new Date(Date.UTC(2026, 3, 27, 19, 0, 0)),
		messages: [
			{ role: "user", content: "Hi", timestamp: "2026-04-27T18:32:05Z" },
			{
				role: "assistant",
				content: "Hello",
				timestamp: "2026-04-27T18:33:00Z",
			},
			{
				role: "user",
				content: "Thanks",
				timestamp: "2026-04-27T18:34:00Z",
			},
		],
		...overrides,
	};
}

describe("computeSessionStatistics", () => {
	test("counts user and agent messages and records markdown size", () => {
		const stats = computeSessionStatistics(fixture(), "abc");
		expect(stats.user_message_count).toBe(2);
		expect(stats.agent_message_count).toBe(1);
		expect(stats.markdown_size_bytes).toBe(3);
		expect(stats.provider).toBe("claude-code");
	});

	test("uses message timestamps for start/end when present", () => {
		const stats = computeSessionStatistics(fixture(), "");
		expect(stats.start_timestamp).toBe("2026-04-27T18:32:05Z");
		expect(stats.end_timestamp).toBe("2026-04-27T18:34:00Z");
	});

	test("falls back to session timestamps when messages have none", () => {
		const stats = computeSessionStatistics(
			fixture({
				messages: [
					{ role: "user", content: "Hi" },
					{ role: "assistant", content: "Hello" },
				],
			}),
			"",
		);
		expect(stats.start_timestamp).toBe(
			new Date(Date.UTC(2026, 3, 27, 18, 32, 5)).toISOString(),
		);
		expect(stats.end_timestamp).toBe(
			new Date(Date.UTC(2026, 3, 27, 19, 0, 0)).toISOString(),
		);
	});
});

describe("StatisticsCollector", () => {
	test("flush writes a fresh statistics.json with the pending entries", () => {
		const c = new StatisticsCollector();
		c.add("s1", computeSessionStatistics(fixture(), "abc"));
		c.flush(statsPath);
		expect(existsSync(statsPath)).toBe(true);
		const file = JSON.parse(readFileSync(statsPath, "utf8"));
		expect(file.sessions.s1.user_message_count).toBe(2);
	});

	test("flush merges into an existing file without dropping prior sessions", () => {
		writeFileSync(
			statsPath,
			JSON.stringify({
				sessions: { existing: { user_message_count: 99, provider: "codex" } },
			}),
		);
		const c = new StatisticsCollector();
		c.add("s1", computeSessionStatistics(fixture(), "abc"));
		c.flush(statsPath);
		const file = JSON.parse(readFileSync(statsPath, "utf8"));
		expect(file.sessions.existing.user_message_count).toBe(99);
		expect(file.sessions.s1.user_message_count).toBe(2);
	});

	test("flush starts fresh when the existing file is corrupt JSON", () => {
		writeFileSync(statsPath, "{not valid json");
		const c = new StatisticsCollector();
		c.add("s1", computeSessionStatistics(fixture(), "abc"));
		c.flush(statsPath);
		const file = JSON.parse(readFileSync(statsPath, "utf8"));
		expect(Object.keys(file.sessions)).toEqual(["s1"]);
	});

	test("flush is a no-op when nothing has been added", () => {
		const c = new StatisticsCollector();
		c.flush(statsPath);
		expect(existsSync(statsPath)).toBe(false);
	});
});
