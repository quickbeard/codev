import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync as Database } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openCodeProvider } from "@/providers/opencode.js";

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
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-opencode-")));
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	const dataDir = join(tempHome, ".local", "share", "opencode");
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
	run(
		db,
		"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
		[
			"msg-2",
			"ses-1",
			Math.floor(Date.UTC(2026, 3, 27, 18, 33, 0) / 1000),
			JSON.stringify({ role: "assistant", modelID: "claude-sonnet-4-5" }),
		],
	);
	run(
		db,
		"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
		[
			"part-2",
			"msg-2",
			"ses-1",
			Math.floor(Date.UTC(2026, 3, 27, 18, 33, 0) / 1000),
			JSON.stringify({ type: "text", text: "Sure — let's start." }),
		],
	);
	// A reasoning part should be ignored by the v1 renderer.
	run(
		db,
		"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
		[
			"part-3",
			"msg-2",
			"ses-1",
			Math.floor(Date.UTC(2026, 3, 27, 18, 33, 1) / 1000),
			JSON.stringify({ type: "reasoning", text: "Internal thinking" }),
		],
	);
	db.close();
}

describe("openCodeProvider.detect", () => {
	test("returns false when the database does not exist", async () => {
		expect(await openCodeProvider.detect(projectCwd)).toBe(false);
	});

	test("returns true when a project row matches the cwd", async () => {
		seedProjectAndSession();
		expect(await openCodeProvider.detect(projectCwd)).toBe(true);
	});

	test("returns false when no project matches the cwd", async () => {
		seedProjectAndSession();
		const otherCwd = join(tempHome, "elsewhere");
		mkdirSync(otherCwd, { recursive: true });
		expect(await openCodeProvider.detect(otherCwd)).toBe(false);
	});

	test("falls back to global project when matching directory column", async () => {
		const db = new Database(dbPath);
		createSchema(db);
		run(db, "INSERT INTO project (id, worktree) VALUES (?, ?)", [
			"global",
			"/",
		]);
		run(
			db,
			"INSERT INTO session (id, project_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"ses-global",
				"global",
				"slug",
				"Title",
				projectCwd,
				Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
				Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
			],
		);
		db.close();
		expect(await openCodeProvider.detect(projectCwd)).toBe(true);
	});
});

describe("openCodeProvider.listSessions", () => {
	test("returns sessions with text parts only, dropping reasoning parts", async () => {
		seedProjectAndSession();
		const sessions = await openCodeProvider.listSessions(projectCwd);
		expect(sessions.length).toBe(1);
		const s = sessions[0];
		if (!s) throw new Error("expected one session");
		expect(s.id).toBe("ses-1");
		expect(s.agent).toBe("opencode");
		expect(s.firstUserMessage).toBe("Refactor the auth module");
		expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(s.messages[1]?.content).toBe(
			"Sure — let's start.\n<details><summary>Thought</summary>\n\nInternal thinking\n</details>",
		);
	});

	test("attaches modelID from message data to assistant messages", async () => {
		seedProjectAndSession();
		const sessions = await openCodeProvider.listSessions(projectCwd);
		const s = sessions[0];
		if (!s) throw new Error("expected session");
		// Assistant message (msg-2) has modelID: "claude-sonnet-4-5" in seed data
		expect(s.messages[1]?.model).toBe("claude-sonnet-4-5");
		// User message should not expose a model
		expect(s.messages[0]?.model).toBeUndefined();
	});

	test("reads modelID from nested model.modelID when flat modelID is absent", async () => {
		// Real OpenCode data stores model as { providerID, modelID } on user rows
		// and assistant rows may also use that shape in some versions.
		const db = new Database(dbPath);
		createSchema(db);
		run(db, "INSERT INTO project (id, worktree) VALUES (?, ?)", [
			"proj-nested",
			projectCwd,
		]);
		run(
			db,
			"INSERT INTO session (id, project_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"ses-nested",
				"proj-nested",
				"slug",
				"Nested model",
				projectCwd,
				Math.floor(Date.UTC(2026, 3, 28, 10, 0, 0) / 1000),
				Math.floor(Date.UTC(2026, 3, 28, 10, 5, 0) / 1000),
			],
		);
		run(
			db,
			"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
			[
				"msg-n1",
				"ses-nested",
				Math.floor(Date.UTC(2026, 3, 28, 10, 0, 0) / 1000),
				JSON.stringify({ role: "user" }),
			],
		);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-n1",
				"msg-n1",
				"ses-nested",
				Math.floor(Date.UTC(2026, 3, 28, 10, 0, 0) / 1000),
				JSON.stringify({ type: "text", text: "Hello" }),
			],
		);
		run(
			db,
			"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
			[
				"msg-n2",
				"ses-nested",
				Math.floor(Date.UTC(2026, 3, 28, 10, 1, 0) / 1000),
				// nested model object — shape used by real OpenCode for user rows
				JSON.stringify({
					role: "assistant",
					model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
				}),
			],
		);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-n2",
				"msg-n2",
				"ses-nested",
				Math.floor(Date.UTC(2026, 3, 28, 10, 1, 0) / 1000),
				JSON.stringify({ type: "text", text: "Hi there!" }),
			],
		);
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		const nested = sessions.find((s) => s.id === "ses-nested");
		if (!nested) throw new Error("expected nested session");
		expect(nested.messages[1]?.model).toBe("claude-opus-4-7");
	});

	test("excludes subagent (child) sessions, keeping only the parent", async () => {
		seedProjectAndSession();
		const db = new Database(dbPath);
		// A subagent session: same project, but parent_id points at ses-1. It has
		// its own message so it would otherwise build into a standalone session.
		run(
			db,
			"INSERT INTO session (id, project_id, parent_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"ses-sub",
				"proj-1",
				"ses-1",
				"explore",
				"Find staging models (@explore subagent)",
				projectCwd,
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 0) / 1000),
				Math.floor(Date.UTC(2026, 3, 27, 18, 41, 0) / 1000),
			],
		);
		run(
			db,
			"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
			[
				"msg-sub",
				"ses-sub",
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 0) / 1000),
				JSON.stringify({ role: "user" }),
			],
		);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-sub",
				"msg-sub",
				"ses-sub",
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 0) / 1000),
				JSON.stringify({ type: "text", text: "Find staging models" }),
			],
		);
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		expect(sessions.map((s) => s.id)).toEqual(["ses-1"]);
	});

	test("rolls up subagent descendant char counts into parent session", async () => {
		seedProjectAndSession();
		const db = new Database(dbPath);
		// Child session with parent_id = ses-1.
		run(
			db,
			"INSERT INTO session (id, project_id, parent_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"ses-child",
				"proj-1",
				"ses-1",
				"explore",
				"Find staging models (@explore subagent)",
				projectCwd,
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 0) / 1000),
				Math.floor(Date.UTC(2026, 3, 27, 18, 41, 0) / 1000),
			],
		);
		// User message in child: 10 chars.
		run(
			db,
			"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
			[
				"msg-child-u",
				"ses-child",
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 0) / 1000),
				JSON.stringify({ role: "user" }),
			],
		);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-child-u",
				"msg-child-u",
				"ses-child",
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 0) / 1000),
				JSON.stringify({ type: "text", text: "1234567890" }), // 10 chars
			],
		);
		// Assistant message in child: 20 chars.
		run(
			db,
			"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
			[
				"msg-child-a",
				"ses-child",
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 5) / 1000),
				JSON.stringify({ role: "assistant" }),
			],
		);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-child-a",
				"msg-child-a",
				"ses-child",
				Math.floor(Date.UTC(2026, 3, 27, 18, 40, 5) / 1000),
				JSON.stringify({ type: "text", text: "12345678901234567890" }), // 20 chars
			],
		);
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		const parent = sessions.find((s) => s.id === "ses-1");
		expect(parent).toBeDefined();
		expect(parent?.subagentCharsIn).toBe(10);
		expect(parent?.subagentCharsOut).toBe(20);
	});

	test("falls back to all sessions when the schema has no parent_id column", async () => {
		// A legacy OpenCode DB predating subagents: the session table has no
		// parent_id. The filter/rollup must degrade to exporting every session
		// rather than throwing "no such column" and dropping the whole provider.
		const db = new Database(dbPath);
		run(db, "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)");
		run(
			db,
			"CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)",
		);
		run(
			db,
			"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
		);
		run(
			db,
			"CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
		);
		run(db, "INSERT INTO project (id, worktree) VALUES (?, ?)", [
			"proj-1",
			projectCwd,
		]);
		for (const id of ["ses-a", "ses-b"]) {
			run(
				db,
				"INSERT INTO session (id, project_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[
					id,
					"proj-1",
					id,
					`Title ${id}`,
					projectCwd,
					Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
					Math.floor(Date.UTC(2026, 3, 27, 19, 0, 0) / 1000),
				],
			);
			run(
				db,
				"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
				[
					`msg-${id}`,
					id,
					Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
					JSON.stringify({ role: "user" }),
				],
			);
			run(
				db,
				"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
				[
					`part-${id}`,
					`msg-${id}`,
					id,
					Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
					JSON.stringify({ type: "text", text: `Hello from ${id}` }),
				],
			);
		}
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		// Both sessions returned — no folding, no throw.
		expect(sessions.map((s) => s.id).sort()).toEqual(["ses-a", "ses-b"]);
		// Rollup skipped: no parent links to walk.
		for (const s of sessions) {
			expect(s.subagentCharsIn).toBeUndefined();
			expect(s.subagentCharsOut).toBeUndefined();
		}
	});

	test("returns empty list when no project matches the cwd", async () => {
		seedProjectAndSession();
		const otherCwd = join(tempHome, "elsewhere");
		mkdirSync(otherCwd, { recursive: true });
		const sessions = await openCodeProvider.listSessions(otherCwd);
		expect(sessions).toEqual([]);
	});

	test("marks completed and errored edit tools with acceptance status", async () => {
		seedProjectAndSession();
		const db = new Database(dbPath);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-4",
				"msg-2",
				"ses-1",
				Math.floor(Date.UTC(2026, 3, 27, 18, 33, 2) / 1000),
				JSON.stringify({
					type: "tool",
					tool: "edit",
					callID: "edit-1",
					state: {
						status: "completed",
						input: { filePath: "/tmp/a.ts" },
						metadata: { diff: "-old\n+new" },
					},
				}),
			],
		);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-5",
				"msg-2",
				"ses-1",
				Math.floor(Date.UTC(2026, 3, 27, 18, 33, 3) / 1000),
				JSON.stringify({
					type: "tool",
					tool: "edit",
					callID: "edit-2",
					state: {
						status: "error",
						input: {
							filePath: "/tmp/b.ts",
							oldString: "const lucky = false;",
							newString: "const lucky = true;",
						},
						error: "Tool execution aborted",
					},
				}),
			],
		);
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="accepted">',
		);
		expect(assistantContent).toContain("```diff\n-old\n+new\n```");
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="rejected">',
		);
		expect(assistantContent).toContain("-const lucky = false;");
		expect(assistantContent).toContain("+const lucky = true;");
		expect(assistantContent).toContain("Error: Tool execution aborted");
	});

	test("reconstructs diff from old/newString when a completed edit has no metadata", async () => {
		// Older OpenCode runs (and any session whose patch-metadata side-channel
		// is missing) must still surface what changed on an accepted edit —
		// otherwise edit-acceptance analytics undercount accepted LOC.
		seedProjectAndSession();
		const db = new Database(dbPath);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-no-meta",
				"msg-2",
				"ses-1",
				Math.floor(Date.UTC(2026, 3, 27, 18, 33, 4) / 1000),
				JSON.stringify({
					type: "tool",
					tool: "edit",
					callID: "edit-no-meta",
					state: {
						status: "completed",
						input: {
							filePath: "/tmp/c.ts",
							oldString: "const lucky = false;",
							newString: "const lucky = true;",
						},
					},
				}),
			],
		);
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="accepted">',
		);
		expect(assistantContent).toContain("-const lucky = false;");
		expect(assistantContent).toContain("+const lucky = true;");
		expect(assistantContent).not.toContain("Edit applied successfully.");
	});

	test("renders write (file creation) content as an all-additions diff", async () => {
		seedProjectAndSession();
		const db = new Database(dbPath);
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-write",
				"msg-2",
				"ses-1",
				Math.floor(Date.UTC(2026, 3, 27, 18, 33, 5) / 1000),
				JSON.stringify({
					type: "tool",
					tool: "write",
					callID: "write-1",
					state: {
						status: "completed",
						input: {
							filePath: "/tmp/new.ts",
							content: "const a = 1;\nconst b = 2;",
						},
					},
				}),
			],
		);
		// A rejected write must keep its content so proposed/rejected LOC count.
		run(
			db,
			"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
			[
				"part-write-rej",
				"msg-2",
				"ses-1",
				Math.floor(Date.UTC(2026, 3, 27, 18, 33, 6) / 1000),
				JSON.stringify({
					type: "tool",
					tool: "write",
					callID: "write-2",
					state: {
						status: "error",
						input: {
							filePath: "/tmp/rejected.ts",
							content: "line one\nline two\nline three",
						},
						error: "Tool execution aborted",
					},
				}),
			],
		);
		db.close();

		const sessions = await openCodeProvider.listSessions(projectCwd);
		const assistantContent = sessions[0]?.messages[1]?.content || "";
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="accepted">',
		);
		expect(assistantContent).toContain(
			"```diff\n+const a = 1;\n+const b = 2;\n```",
		);
		expect(assistantContent).toContain(
			'<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="rejected">',
		);
		expect(assistantContent).toContain("+line one");
		expect(assistantContent).toContain("+line three");
		expect(assistantContent).toContain("Error: Tool execution aborted");
	});

	test("honors XDG_DATA_HOME for the database location", async () => {
		const xdg = realpathSync(
			mkdtempSync(join(tmpdir(), "codev-opencode-xdg-")),
		);
		try {
			const xdgOpencodeDir = join(xdg, "opencode");
			mkdirSync(xdgOpencodeDir, { recursive: true });
			const xdgDbPath = join(xdgOpencodeDir, "opencode.db");
			const db = new Database(xdgDbPath);
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
					"slug",
					"Title",
					projectCwd,
					Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
					Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000),
				],
			);
			db.close();
			process.env.XDG_DATA_HOME = xdg;
			expect(await openCodeProvider.detect(projectCwd)).toBe(true);
		} finally {
			rmSync(xdg, { recursive: true, force: true });
		}
	});
});
