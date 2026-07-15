import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffFromEditInput, diffFromWriteContent } from "@/lib/diff.js";
import { codeFence } from "@/lib/markdown.js";
import type { Agent, Message, Provider, Session } from "@/providers/types.js";

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

function dataDir(app: string): string {
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) return join(xdg, app);
	return join(homedir(), ".local", "share", app);
}

// The codev-code fork keeps the `opencode.db` filename; only the app dir
// segment differs (its `Global.Path` constant is "codev").
function dbPath(app: string): string {
	return join(dataDir(app), "opencode.db");
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

// OpenCode records project/session paths POSIX-style — forward slashes even on
// Windows (e.g. it stores "C:/Users/me/project" while Node's realpathSync
// returns "C:\\Users\\me\\project"). It can also capture a different
// drive-letter case than the shell the user later runs `codevhub upload` from. A
// raw `worktree = ?` / `directory = ?` equality check therefore misses, and the
// provider reports "No conversations found" for a project that was in fact used.
// Normalize both sides for comparison: unify separators, uppercase a leading
// drive letter, and NFC-normalize Unicode. This is match-only — the actual
// stored string is still used for the follow-up session query so it stays exact.
function normalizePathForMatch(p: string): string {
	const unified = p.normalize("NFC").replace(/\\/g, "/");
	return unified.replace(
		/^([a-zA-Z]):/,
		(_m, drive: string) => `${drive.toUpperCase()}:`,
	);
}

interface ProjectMatch {
	projectId: string;
	directoryFilter: string;
}

interface SessionRow {
	id: string;
	title: string | null;
	directory: string | null;
	// Set on subagent sessions, pointing at the spawning session. Top-level
	// sessions have it NULL. Subagent runs are folded into their parent (the
	// parent already embeds the spawn prompt + result as an inline `task`
	// tool-use), so child rows are skipped rather than uploaded as standalone
	// conversations. Optional: older OpenCode schemas predate the column, in
	// which case it's omitted from the SELECT entirely.
	parent_id?: string | null;
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
	const target = normalizePathForMatch(canonical(cwd));

	// Compare normalized worktrees in JS rather than via `worktree = ?` — the
	// stored value may use forward slashes / a different drive-letter case than
	// realpathSync yields. The project table is tiny, so scanning it is cheap.
	const projects = db
		.prepare<[], { id: string; worktree: string | null }>(
			"SELECT id, worktree FROM project",
		)
		.all();
	for (const project of projects) {
		if (
			project.worktree &&
			normalizePathForMatch(project.worktree) === target
		) {
			return { projectId: project.id, directoryFilter: "" };
		}
	}

	// Global fallback: VCS-less sessions live under project_id='global',
	// distinguished by their own `directory`. Match on the normalized form but
	// return the exact stored string so the follow-up session query stays exact.
	const globalDirs = db
		.prepare<[], { directory: string | null }>(
			"SELECT DISTINCT directory FROM session WHERE project_id = 'global'",
		)
		.all();
	for (const row of globalDirs) {
		if (row.directory && normalizePathForMatch(row.directory) === target) {
			return { projectId: "global", directoryFilter: row.directory };
		}
	}
	return null;
}

// OpenCode added the session.parent_id column when it introduced subagents.
// Databases from older versions lack it, so probe before relying on it —
// without this, the parent_id queries below throw "no such column: parent_id"
// and runExport drops EVERY OpenCode session. When the column is absent we fall
// back to the pre-subagent behavior: export all sessions, skip the rollup.
function sessionHasParentId(db: DB): boolean {
	try {
		const cols = db
			.prepare<[], { name: string }>("PRAGMA table_info(session)")
			.all();
		return cols.some((c) => c.name === "parent_id");
	} catch {
		return false;
	}
}

function listSessionRows(
	db: DB,
	match: ProjectMatch,
	hasParentId: boolean,
): SessionRow[] {
	// `parent_id IS NULL` drops normal-mode subagent sessions — they're folded
	// into their spawning session, which already carries the spawn inline.
	// Headless subagents (no parent_id) appear standalone, counted independently.
	// On schemas without the column, select every session instead — exporting a
	// subagent as standalone beats throwing and losing the whole provider.
	const cols = hasParentId
		? "id, title, directory, parent_id, time_created, time_updated"
		: "id, title, directory, time_created, time_updated";
	const parentFilter = hasParentId ? " AND parent_id IS NULL" : "";
	if (match.directoryFilter) {
		return db
			.prepare<[string, string], SessionRow>(
				`SELECT ${cols} FROM session WHERE project_id = ? AND directory = ?${parentFilter} ORDER BY time_created`,
			)
			.all(match.projectId, match.directoryFilter);
	}
	return db
		.prepare<[string], SessionRow>(
			`SELECT ${cols} FROM session WHERE project_id = ?${parentFilter} ORDER BY time_created`,
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
			// Render the new file as an all-additions diff so the LOC enricher
			// counts every line — a plain code fence counts as zero, the same bug
			// edits used to have. Keep the content on rejection so proposed/rejected
			// LOC are still attributed.
			const diff = diffFromWriteContent(content);
			let body: string;
			if (diff) {
				body = `${codeFence(diff, "diff")}${isCompleted ? "" : `\n\nError: ${error || "Tool execution aborted"}`}`;
			} else if (isCompleted) {
				body = codeFence(content);
			} else {
				body = `Error: ${error || "Tool execution aborted"}`;
			}
			return `<tool-use data-tool-type="write" data-tool-name="write" data-edit-status="${isCompleted ? "accepted" : "rejected"}">\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
		}

		if (toolName === "edit") {
			const path = typeof input.filePath === "string" ? input.filePath : "";
			const summary = `Edit file: ${path}`;
			// Always reconstruct the diff from oldString/newString when OpenCode
			// didn't attach server-rendered metadata — completed edits without
			// metadata otherwise render as "Edit applied successfully." with no
			// indication of what changed, which would underreport accepted LOC.
			const diff =
				state.metadata?.diff ||
				state.metadata?.filediff?.patch ||
				diffFromEditInput(input);
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

interface ChildChars {
	charsIn: number;
	charsOut: number;
}

/**
 * Recursively sum character counts from all descendant sessions (subagents
 * spawned by this session and their own subagents). Only applicable when
 * parent_id is set (normal interactive mode); headless subagents don't have
 * parent_id and are uploaded as standalone sessions with their own counts.
 */
function collectDescendantChars(db: DB, sessionId: string): ChildChars {
	const children = db
		.prepare<[string], { id: string }>(
			"SELECT id FROM session WHERE parent_id = ?",
		)
		.all(sessionId);

	let charsIn = 0;
	let charsOut = 0;

	for (const child of children) {
		const msgRows = readMessages(db, child.id);
		for (const msg of msgRows) {
			const meta = safeParse<MessageMeta>(msg.data);
			const role = meta?.role === "assistant" ? "assistant" : "user";
			const parts = readParts(db, child.id, msg.id);
			let chars = 0;
			for (const part of parts) {
				const text = parsePart(part);
				if (text) chars += text.length;
			}
			if (role === "user") charsIn += chars;
			else charsOut += chars;
		}
		const nested = collectDescendantChars(db, child.id);
		charsIn += nested.charsIn;
		charsOut += nested.charsOut;
	}

	return { charsIn, charsOut };
}

function buildSession(
	row: SessionRow,
	db: DB,
	hasParentId: boolean,
	agent: Agent,
): Session | null {
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

	// Aggregate char counts from descendant subagent sessions so the parent
	// reflects their cost even though child sessions aren't uploaded separately.
	// Skipped on schemas without parent_id — there are no parent links to walk.
	const { charsIn: subagentCharsIn, charsOut: subagentCharsOut } = hasParentId
		? collectDescendantChars(db, row.id)
		: { charsIn: 0, charsOut: 0 };

	return {
		id: row.id,
		agent,
		createdAt: createdMs ? new Date(createdMs) : new Date(),
		updatedAt: updatedMs ? new Date(updatedMs) : undefined,
		title: row.title || undefined,
		firstUserMessage,
		messages,
		...(subagentCharsIn > 0 || subagentCharsOut > 0
			? { subagentCharsIn, subagentCharsOut }
			: {}),
	};
}

// One implementation serves both OpenCode and the codev-code fork: they share
// the storage schema, differing only in which XDG app dir holds opencode.db.
export function createOpenCodeProvider(agent: Agent, app: string): Provider {
	return {
		agent,

		// OpenCode stores all sessions in a single SQLite db, keyed by project path
		// inside the db rather than by folder — the db file is the location to report.
		describeTarget(_cwd: string): string {
			return dbPath(app);
		},

		async detect(cwd: string): Promise<boolean> {
			const path = dbPath(app);
			if (!existsSync(path)) return false;
			let db: DB | null = null;
			try {
				db = await openDb(path);
				const match = resolveProject(db, cwd);
				if (!match) return false;
				const rows = listSessionRows(db, match, sessionHasParentId(db));
				return rows.length > 0;
			} catch {
				return false;
			} finally {
				db?.close();
			}
		},

		async listSessions(cwd: string): Promise<Session[]> {
			const path = dbPath(app);
			if (!existsSync(path)) return [];
			const db = await openDb(path);
			try {
				const match = resolveProject(db, cwd);
				if (!match) return [];
				const hasParentId = sessionHasParentId(db);
				const rows = listSessionRows(db, match, hasParentId);
				const sessions: Session[] = [];
				for (const row of rows) {
					try {
						const session = buildSession(row, db, hasParentId, agent);
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
}

export const openCodeProvider: Provider = createOpenCodeProvider(
	"opencode",
	"opencode",
);
