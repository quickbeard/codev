import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffFromEditInput } from "@/lib/diff.js";
import { codeFence } from "@/lib/markdown.js";
import type { Message, Provider, Session } from "@/providers/types.js";

interface Stmt<P extends unknown[], R> {
	get(...args: P): R | undefined;
	all(...args: P): R[];
}

interface DB {
	prepare<P extends unknown[], R>(sql: string): Stmt<P, R>;
	close(): void;
}

// `node:sqlite` is loaded lazily so that non-upload commands (--version,
// install, etc.) don't trigger Node's ExperimentalWarning at bundle link
// time. The upload path goes through `ensureNodeSqliteOrReexec`, which
// re-execs with `--disable-warning=ExperimentalWarning` when needed, so the
// dynamic import inside this function stays silent.
async function openDb(path: string): Promise<DB> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: true });
	return {
		prepare<P extends unknown[], R>(sql: string): Stmt<P, R> {
			const stmt = db.prepare(sql);
			return {
				// node:sqlite's bind types accept SQLInputValue; our generic is wider.
				// biome-ignore lint/suspicious/noExplicitAny: bind-type widening
				get: (...args: P) => stmt.get(...(args as any[])) as R | undefined,
				// biome-ignore lint/suspicious/noExplicitAny: bind-type widening
				all: (...args: P) => stmt.all(...(args as any[])) as R[],
			};
		},
		close: () => db.close(),
	};
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

// OpenCode normally stores per-project sessions under a `project` row whose
// `worktree` matches the cwd. When OpenCode can't find a VCS root it dumps
// sessions under a "global" project, distinguished by the session's own
// `directory` column.
function resolveProject(db: DB, cwd: string): ProjectMatch | null {
	const target = canonical(cwd);
	const direct = db
		.prepare<[string], { id: string }>(
			"SELECT id FROM project WHERE worktree = ?",
		)
		.get(target);
	if (direct?.id) return { projectId: direct.id, directoryFilter: "" };

	const fallback = db
		.prepare<[string], { count: number }>(
			"SELECT COUNT(*) as count FROM session WHERE project_id = 'global' AND directory = ?",
		)
		.get(target);
	if (fallback && fallback.count > 0) {
		return { projectId: "global", directoryFilter: target };
	}
	return null;
}

function listSessionRows(db: DB, match: ProjectMatch): SessionRow[] {
	if (match.directoryFilter) {
		return db
			.prepare<[string, string], SessionRow>(
				"SELECT id, title, directory, time_created, time_updated " +
					"FROM session WHERE project_id = ? AND directory = ? ORDER BY time_created",
			)
			.all(match.projectId, match.directoryFilter);
	}
	return db
		.prepare<[string], SessionRow>(
			"SELECT id, title, directory, time_created, time_updated " +
				"FROM session WHERE project_id = ? ORDER BY time_created",
		)
		.all(match.projectId);
}

function readMessages(db: DB, sessionId: string): MessageRow[] {
	return db
		.prepare<[string], MessageRow>(
			"SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created",
		)
		.all(sessionId);
}

function readParts(db: DB, sessionId: string, messageId: string): PartRow[] {
	return db
		.prepare<[string, string], PartRow>(
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

function formatDuration(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
	}
	return `${ms}ms`;
}

interface ReasoningPart {
	type: "reasoning";
	text: string;
	time?: { start: number; end: number };
}

interface ToolPart {
	type: "tool";
	tool: string;
	callID: string;
	state: {
		status: "completed" | "error";
		input: Record<string, unknown>;
		output?: string;
		error?: string;
		metadata?: {
			diff?: string;
			filediff?: { patch: string };
		};
	};
}

interface TextPart {
	type: "text";
	text: string;
}

function parsePart(part: PartRow): string | null {
	const obj = safeParse<{ type?: string }>(part.data);
	if (!obj) return null;

	if (obj.type === "text") {
		const textPart = obj as TextPart;
		return typeof textPart.text === "string" ? textPart.text : null;
	}

	if (obj.type === "reasoning") {
		const reasonPart = obj as ReasoningPart;
		if (typeof reasonPart.text !== "string" || !reasonPart.text.trim())
			return null;

		let durationStr = "";
		if (
			reasonPart.time &&
			typeof reasonPart.time.start === "number" &&
			typeof reasonPart.time.end === "number"
		) {
			const diff = reasonPart.time.end - reasonPart.time.start;
			if (diff >= 0) {
				durationStr = ` for ${formatDuration(diff)}`;
			}
		}
		return `<details><summary>Thought${durationStr}</summary>\n\n${reasonPart.text.trim()}\n</details>\n`;
	}

	if (obj.type === "tool") {
		const toolPart = obj as ToolPart;
		const toolName = toolPart.tool;
		const state = toolPart.state || {};
		const isCompleted = state.status === "completed";
		const input = state.input || {};
		const output = state.output || "";
		const error = state.error || "";

		if (toolName === "bash") {
			const cmd = typeof input.command === "string" ? input.command : "";
			const desc =
				typeof input.description === "string" ? input.description : "";
			const summary = `Run command: ${cmd}`;
			const descSection = desc ? `Description: ${desc}\n\n` : "";
			const body = `${descSection}${codeFence(
				`$ ${cmd}\n${isCompleted ? output : `Error: ${error || "Tool execution aborted"}`}`,
				"bash",
			)}`;
			return `<tool-use data-tool-type="shell" data-tool-name="bash">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "read") {
			const path = typeof input.filePath === "string" ? input.filePath : "";
			const summary = `Read file: ${path}`;
			const body = isCompleted
				? output
				: `Error: ${error || "Tool execution aborted"}`;
			return `<tool-use data-tool-type="read" data-tool-name="read">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "glob") {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			const summary = `Glob files: ${pattern}`;
			const body = codeFence(
				`Pattern: ${pattern}\nMatches:\n${isCompleted ? output : `Error: ${error || "Tool execution aborted"}`}`,
			);
			return `<tool-use data-tool-type="glob" data-tool-name="glob">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "grep") {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			const path = typeof input.path === "string" ? input.path : "";
			const summary = `Grep search: ${pattern}`;
			const body = codeFence(
				`Pattern: ${pattern}\nPath: ${path}\nMatches:\n${isCompleted ? output : `Error: ${error || "Tool execution aborted"}`}`,
			);
			return `<tool-use data-tool-type="grep" data-tool-name="grep">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "write") {
			const path = typeof input.filePath === "string" ? input.filePath : "";
			const content = typeof input.content === "string" ? input.content : "";
			const summary = `Edit file: ${path}`;
			const body = isCompleted
				? codeFence(content)
				: `Error: ${error || "Tool execution aborted"}`;
			return `<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="${isCompleted ? "accepted" : "rejected"}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "edit") {
			const path = typeof input.filePath === "string" ? input.filePath : "";
			const summary = `Edit file: ${path}`;
			const diff =
				state.metadata?.diff ||
				state.metadata?.filediff?.patch ||
				(isCompleted ? "" : diffFromEditInput(input));
			let body: string;
			if (diff) {
				body = `${codeFence(diff, "diff")}${isCompleted ? "" : `\n\nError: ${error || "Tool execution aborted"}`}`;
			} else if (isCompleted) {
				body = "Edit applied successfully.";
			} else {
				body = `Error: ${error || "Tool execution aborted"}`;
			}
			return `<tool-use data-tool-type="write" data-tool-name="edit" data-edit-status="${isCompleted ? "accepted" : "rejected"}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "task") {
			const desc =
				typeof input.description === "string" ? input.description : "";
			const prompt = typeof input.prompt === "string" ? input.prompt : "";
			const subagent =
				typeof input.subagent_type === "string" ? input.subagent_type : "";
			const summary = `Spawn subagent: ${desc || subagent}`;
			const body = `**Subagent Type**: ${subagent}\n**Prompt**:\n${prompt}\n\n**Result**:\n${isCompleted ? output : `Error: ${error || "Subagent execution aborted"}`}`;
			return `<tool-use data-tool-type="task" data-tool-name="task">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		// Fallback for any other/generic tool
		const summary = `Call tool: ${toolName}`;
		const body = codeFence(JSON.stringify(state, null, 2), "json");
		return `<tool-use data-tool-type="tool" data-tool-name="${toolName}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
	}

	return null;
}

interface MessageMeta {
	role?: string;
	/** Flat model id on assistant rows (e.g. "claude-sonnet-4-5") */
	modelID?: string;
	/** Nested model object on user rows: { providerID, modelID } */
	model?: { providerID?: string; modelID?: string };
}

function buildSession(row: SessionRow, db: DB): Session | null {
	const messages: Message[] = [];
	let firstUserMessage = "";
	const msgRows = readMessages(db, row.id);

	for (const msg of msgRows) {
		const meta = safeParse<MessageMeta>(msg.data);
		const role = meta?.role === "assistant" ? "assistant" : "user";
		const parts = readParts(db, row.id, msg.id);
		const textParts: string[] = [];
		for (const part of parts) {
			const text = parsePart(part);
			if (text) textParts.push(text);
		}
		const content = textParts.join("\n").trim();
		if (!content) continue;
		const timestamp = unixToISO(msg.time_created);
		// Model id is stored as a flat string on assistant rows and as a nested
		// object on user rows.  Read both shapes; only attach to assistant turns
		// since that's what the markdown header and analytics track.
		const modelId = meta?.modelID || meta?.model?.modelID || undefined;
		messages.push({
			role,
			content,
			timestamp,
			model: role === "assistant" ? modelId : undefined,
		});
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
		let db: DB | null = null;
		try {
			db = await openDb(path);
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
		const db = await openDb(path);
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
