// Smoke test for the node:sqlite branch of openDb() in
// src/providers/opencode.ts. `bun test` runs under Bun and exercises the
// bun:sqlite branch via opencode.test.ts, so this test shells out to
// `node dist/index.js upload` against a seeded OpenCode DB and asserts on the
// filesystem output written by the export half of the upload pipeline. It is
// the only coverage of the Node-runtime SQLite path — without it, a regression
// would only surface for users running the published CLI. On Node < 23.5 the
// CLI re-execs itself with --experimental-sqlite (see src/lib/reexec.ts), which
// is also exercised here.
//
// `upload` will fail when its network half tries to reach the fake Supabase
// URL we seed, but the export half runs first and writes the markdown files we
// assert on, so the non-zero exit is expected and tolerated.
//
// The test runs whatever bundle currently sits in dist/index.js, and only
// rebuilds when the bundle is missing. After changing src/, re-run
// `bun run build` before re-running this test.

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = realpathSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
);
const DIST_PATH = join(REPO_ROOT, "dist", "index.js");

let tempHome: string;
let projectCwd: string;

beforeAll(() => {
	if (existsSync(DIST_PATH)) return;
	const built = spawnSync("bun", ["run", "build"], {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
	if (built.status !== 0) {
		throw new Error(`bun run build failed (exit ${built.status})`);
	}
});

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-node-")));
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	mkdirSync(join(tempHome, ".local", "share", "opencode"), { recursive: true });
});

afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
});

function seedDb(): void {
	const dbPath = join(tempHome, ".local", "share", "opencode", "opencode.db");
	const db = new Database(dbPath);
	db.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)");
	db.run(
		"CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)",
	);
	db.run(
		"CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
	);
	db.run(
		"CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
	);
	const ts = Math.floor(Date.UTC(2026, 3, 27, 18, 32, 5) / 1000);
	db.run("INSERT INTO project (id, worktree) VALUES (?, ?)", [
		"proj-1",
		projectCwd,
	]);
	db.run(
		"INSERT INTO session (id, project_id, slug, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
		["ses-1", "proj-1", "refactor", "Refactor", projectCwd, ts, ts],
	);
	db.run(
		"INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
		["msg-1", "ses-1", ts, JSON.stringify({ role: "user" })],
	);
	db.run(
		"INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
		[
			"part-1",
			"msg-1",
			"ses-1",
			ts,
			JSON.stringify({ type: "text", text: "Refactor the auth module" }),
		],
	);
	db.close();
}

function seedAuth(): void {
	const codevDir = join(tempHome, ".codev");
	mkdirSync(codevDir, { recursive: true });
	writeFileSync(
		join(codevDir, "auth.json"),
		JSON.stringify({
			access_token: "token",
			id_token: "token",
			expires_at: Date.now() + 3600_000,
			user: { sub: "u", email: "u@example.com", displayName: "User" },
			supabase_url: "http://127.0.0.1:1",
			supabase_anon_key: "anon",
			supabase_proxy_url: "http://127.0.0.1:1/api/codev",
		}),
	);
}

test("`node dist/index.js upload` reads opencode.db via node:sqlite", () => {
	seedDb();
	seedAuth();
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: tempHome,
	};
	delete env.XDG_DATA_HOME;
	// `upload` fails on the network half (fake Supabase URL) but the export
	// half runs first and writes the markdown files we check below.
	spawnSync("node", [DIST_PATH, "upload"], {
		cwd: projectCwd,
		env,
		encoding: "utf8",
	});

	const logsDir = join(tempHome, ".codev", "logs");
	expect(existsSync(logsDir)).toBe(true);
	const projects = readdirSync(logsDir);
	expect(projects.length).toBe(1);
	const projectDir = projects[0];
	if (!projectDir) throw new Error("expected one project dir");
	const opencodeDir = join(logsDir, projectDir, "opencode");
	expect(existsSync(opencodeDir)).toBe(true);
	const files = readdirSync(opencodeDir);
	expect(files.length).toBe(1);
	expect(files[0]).toMatch(/\.md$/);
});
