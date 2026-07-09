import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { codevCodeProvider } from "@/providers/codev-code.js";

// The codev-code fork reuses OpenCode's provider implementation (schema,
// queries, rendering — all covered by tests/providers/opencode.test.ts).
// These tests pin the fork-specific delta: the agent name and the relocated
// XDG app dir its opencode.db lives in.

// node:sqlite has no `run(db, sql, params)` shortcut — DDL uses `exec`, DML uses
// `prepare(sql).run(...params)`. Wrap both shapes so the seed code stays terse.
function run(db: Database, sql: string, params: unknown[] = []): void {
	if (params.length === 0) {
		db.exec(sql);
		return;
	}
	// biome-ignore lint/suspicious/noExplicitAny: SQLInputValue bind-type widening
	db.prepare(sql).run(...(params as any[]));
}

let tempHome: string;
let projectCwd: string;
let dbPath: string;

function createSchema(db: Database): void {
	run(db, "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)");
	run(
		db,
		"CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)",
	);
	run(
		db,
		"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
	);
	run(
		db,
		"CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
	);
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-codev-code-")));
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	const dataDir = join(tempHome, ".local", "share", "codev-code");
	mkdirSync(dataDir, { recursive: true });
	dbPath = join(dataDir, "opencode.db");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
	delete process.env.XDG_DATA_HOME;
});

function seedProjectAndSession(): void {
	const db = new Database(dbPath);
	createSchema(db);
	run(db, "INSERT INTO project (id, worktree) VALUES (?, ?)", [
		"proj-1",
		projectCwd,
	]);
	run(
		db,
		"INSERT INTO session (id, project_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[
			"ses-1",
			"proj-1",
			"refactor",
			"Refactor",
			projectCwd,
			Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
			Math.floor(Date.UTC(2026, 3, 27, 19, 0, 0) / 1000),
		],
	);
	run(
		db,
		"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
		[
			"msg-1",
			"ses-1",
			Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
			JSON.stringify({ role: "user" }),
		],
	);
	run(
		db,
		"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
		[
			"part-1",
			"msg-1",
			"ses-1",
			Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
			JSON.stringify({ type: "text", text: "Refactor the auth module" }),
		],
	);
	db.close();
}

describe("codevCodeProvider", () => {
	test("reports the codev-code agent", () => {
		expect(codevCodeProvider.agent).toBe("codev-code");
	});

	test("describeTarget points at the fork's XDG app dir, not opencode's", () => {
		expect(codevCodeProvider.describeTarget(projectCwd)).toBe(
			join(tempHome, ".local", "share", "codev-code", "opencode.db"),
		);
	});

	test("honors XDG_DATA_HOME for the database location", () => {
		process.env.XDG_DATA_HOME = join(tempHome, "xdg-data");
		expect(codevCodeProvider.describeTarget(projectCwd)).toBe(
			join(tempHome, "xdg-data", "codev-code", "opencode.db"),
		);
	});
});

describe("codevCodeProvider.detect", () => {
	test("returns false when the fork's database does not exist", async () => {
		expect(await codevCodeProvider.detect(projectCwd)).toBe(false);
	});

	test("returns true when a project row matches the cwd in the fork's db", async () => {
		seedProjectAndSession();
		expect(await codevCodeProvider.detect(projectCwd)).toBe(true);
	});
});

describe("codevCodeProvider.listSessions", () => {
	test("tags sessions from the fork's db with the codev-code agent", async () => {
		seedProjectAndSession();
		const sessions = await codevCodeProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected one session");
		expect(s.id).toBe("ses-1");
		expect(s.agent).toBe("codev-code");
		expect(s.firstUserMessage).toBe("Refactor the auth module");
	});
});
