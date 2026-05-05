import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import type { Message, Provider, Session } from "@/providers/types.js";

type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>;
type SqlJsDb = InstanceType<SqlJsModule["Database"]>;

async function loadSqlJs(): Promise<SqlJsModule> {
	// Resolve WASM next to the sql.js package (works for global npm install and
	// `bun link`; avoids `bun:` so `node` can run `dist/index.js`).
	const require = createRequire(fileURLToPath(import.meta.url));
	const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
	return await initSqlJs({
		locateFile: () => wasmPath,
	});
}

let sqlJsCache: Promise<SqlJsModule> | null = null;

function getSqlJs(): Promise<SqlJsModule> {
	if (!sqlJsCache) sqlJsCache = loadSqlJs();
	return sqlJsCache;
}

async function openReadonlyDb(path: string): Promise<SqlJsDb> {
	const SQL = await getSqlJs();
	const file = readFileSync(path);
	return new SQL.Database(file);
}

function dataDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) return join(xdg, "opencode");
	return join(homedir(), ".local", "share", "opencode");
}

function dbPath(): string {
	return join(dataDir(), "opencode.db");
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

interface ProjectMatch {
	projectId: string;
	directoryFilter: string;
}

interface SessionRow {
	id: string;
	title: string | null;
	directory: string | null;
	time_created: number;
	time_updated: number;
}

interface MessageRow {
	id: string;
	time_created: number;
	data: string;
}

interface PartRow {
	id: string;
	message_id: string;
	time_created: number;
	data: string;
}

function rowGet<T extends object>(
	db: SqlJsDb,
	sql: string,
	params: (string | number)[],
): T | undefined {
	const stmt = db.prepare(sql);
	stmt.bind(params);
	if (!stmt.step()) {
		stmt.free();
		return undefined;
	}
	const row = stmt.getAsObject() as T;
	stmt.free();
	return row;
}

function rowAll<T extends object>(
	db: SqlJsDb,
	sql: string,
	params: (string | number)[],
): T[] {
	const stmt = db.prepare(sql);
	stmt.bind(params);
	const rows: T[] = [];
	while (stmt.step()) {
		rows.push(stmt.getAsObject() as T);
	}
	stmt.free();
	return rows;
}

function resolveProject(db: SqlJsDb, cwd: string): ProjectMatch | null {
	const target = canonical(cwd);
	const direct = rowGet<{ id: string }>(
		db,
		"SELECT id FROM project WHERE worktree = ?",
		[target],
	);
	if (direct?.id) return { projectId: direct.id, directoryFilter: "" };

	const fallback = rowGet<{ count: number }>(
		db,
		"SELECT COUNT(*) AS count FROM session WHERE project_id = 'global' AND directory = ?",
		[target],
	);
	if (fallback && fallback.count > 0) {
		return { projectId: "global", directoryFilter: target };
	}
	return null;
}

function listSessionRows(db: SqlJsDb, match: ProjectMatch): SessionRow[] {
	if (match.directoryFilter) {
		return rowAll<SessionRow>(
			db,
			"SELECT id, title, directory, time_created, time_updated " +
				"FROM session WHERE project_id = ? AND directory = ? ORDER BY time_created",
			[match.projectId, match.directoryFilter],
		);
	}
	return rowAll<SessionRow>(
		db,
		"SELECT id, title, directory, time_created, time_updated " +
			"FROM session WHERE project_id = ? ORDER BY time_created",
		[match.projectId],
	);
}

function readMessages(db: SqlJsDb, sessionId: string): MessageRow[] {
	return rowAll<MessageRow>(
		db,
		"SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created",
		[sessionId],
	);
}

function readParts(
	db: SqlJsDb,
	sessionId: string,
	messageId: string,
): PartRow[] {
	return rowAll<PartRow>(
		db,
		"SELECT id, message_id, time_created, data FROM part " +
			"WHERE session_id = ? AND message_id = ? ORDER BY time_created",
		[sessionId, messageId],
	);
}

function safeParse<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function unixToISO(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const epochMs = ms > 1e12 ? ms : ms * 1000;
	return new Date(epochMs).toISOString();
}

function partTextIfPlain(part: PartRow): string | null {
	const obj = safeParse<{ type?: string; text?: string }>(part.data);
	if (!obj) return null;
	if (obj.type !== "text" || typeof obj.text !== "string") return null;
	return obj.text;
}

function buildSession(row: SessionRow, db: SqlJsDb): Session | null {
	const messages: Message[] = [];
	let firstUserMessage = "";
	const msgRows = readMessages(db, row.id);

	for (const msg of msgRows) {
		const meta = safeParse<{ role?: string }>(msg.data);
		const role = meta?.role === "assistant" ? "assistant" : "user";
		const parts = readParts(db, row.id, msg.id);
		const textParts: string[] = [];
		for (const part of parts) {
			const text = partTextIfPlain(part);
			if (text) textParts.push(text);
		}
		const content = textParts.join("\n").trim();
		if (!content) continue;
		const timestamp = unixToISO(msg.time_created);
		messages.push({ role, content, timestamp });
		if (role === "user" && !firstUserMessage) firstUserMessage = content;
	}

	if (messages.length === 0) return null;
	const createdMs = unixToISO(row.time_created);
	const updatedMs = unixToISO(row.time_updated);
	return {
		id: row.id,
		agent: "opencode",
		createdAt: createdMs ? new Date(createdMs) : new Date(),
		updatedAt: updatedMs ? new Date(updatedMs) : undefined,
		firstUserMessage,
		messages,
	};
}

export const openCodeProvider: Provider = {
	agent: "opencode",

	async detect(cwd: string): Promise<boolean> {
		const path = dbPath();
		if (!existsSync(path)) return false;
		let db: SqlJsDb | null = null;
		try {
			db = await openReadonlyDb(path);
			const match = resolveProject(db, cwd);
			if (!match) return false;
			const rows = listSessionRows(db, match);
			return rows.length > 0;
		} catch {
			return false;
		} finally {
			db?.close();
		}
	},

	async listSessions(cwd: string): Promise<Session[]> {
		const path = dbPath();
		if (!existsSync(path)) return [];
		const db = await openReadonlyDb(path);
		try {
			const match = resolveProject(db, cwd);
			if (!match) return [];
			const rows = listSessionRows(db, match);
			const sessions: Session[] = [];
			for (const row of rows) {
				try {
					const session = buildSession(row, db);
					if (session) sessions.push(session);
				} catch {
					// Skip malformed sessions.
				}
			}
			return sessions;
		} finally {
			db.close();
		}
	},
};
