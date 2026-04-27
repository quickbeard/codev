import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, Provider, Session } from "@/providers/types.js";

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

// OpenCode normally stores per-project sessions under a `project` row whose
// `worktree` matches the cwd. When OpenCode can't find a VCS root it dumps
// sessions under a "global" project, distinguished by the session's own
// `directory` column.
function resolveProject(db: Database, cwd: string): ProjectMatch | null {
	const target = canonical(cwd);
	const direct = db
		.query<{ id: string }, [string]>(
			"SELECT id FROM project WHERE worktree = ?",
		)
		.get(target);
	if (direct?.id) return { projectId: direct.id, directoryFilter: "" };

	const fallback = db
		.query<{ count: number }, [string]>(
			"SELECT COUNT(*) as count FROM session WHERE project_id = 'global' AND directory = ?",
		)
		.get(target);
	if (fallback && fallback.count > 0) {
		return { projectId: "global", directoryFilter: target };
	}
	return null;
}

function listSessionRows(db: Database, match: ProjectMatch): SessionRow[] {
	if (match.directoryFilter) {
		return db
			.query<SessionRow, [string, string]>(
				"SELECT id, title, directory, time_created, time_updated " +
					"FROM session WHERE project_id = ? AND directory = ? ORDER BY time_created",
			)
			.all(match.projectId, match.directoryFilter);
	}
	return db
		.query<SessionRow, [string]>(
			"SELECT id, title, directory, time_created, time_updated " +
				"FROM session WHERE project_id = ? ORDER BY time_created",
		)
		.all(match.projectId);
}

function readMessages(db: Database, sessionId: string): MessageRow[] {
	return db
		.query<MessageRow, [string]>(
			"SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created",
		)
		.all(sessionId);
}

function readParts(
	db: Database,
	sessionId: string,
	messageId: string,
): PartRow[] {
	return db
		.query<PartRow, [string, string]>(
			"SELECT id, message_id, time_created, data FROM part " +
				"WHERE session_id = ? AND message_id = ? ORDER BY time_created",
		)
		.all(sessionId, messageId);
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
	// OpenCode timestamps may be seconds or milliseconds; treat large values as ms.
	const epochMs = ms > 1e12 ? ms : ms * 1000;
	return new Date(epochMs).toISOString();
}

// OpenCode parts have many shapes (text, reasoning, tool, ...). For v1 we
// only surface plain text — tools/reasoning are parsed separately and we drop
// them rather than trying to render them as markdown.
function partTextIfPlain(part: PartRow): string | null {
	const obj = safeParse<{ type?: string; text?: string }>(part.data);
	if (!obj) return null;
	if (obj.type !== "text" || typeof obj.text !== "string") return null;
	return obj.text;
}

function buildSession(row: SessionRow, db: Database): Session | null {
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
		let db: Database | null = null;
		try {
			db = new Database(path, { readonly: true });
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
		const db = new Database(path, { readonly: true });
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
