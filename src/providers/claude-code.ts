import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderToolUse } from "@/lib/tool-render.js";
import type { Message, Provider, Session } from "@/providers/types.js";

// Claude Code stores sessions under ~/.claude/projects/<munged-cwd>/, where the
// directory name is the absolute (symlink-resolved) cwd with every
// non-alphanumeric character replaced by a dash. On POSIX the leading slash
// becomes that dash naturally (`/Users/x` -> `-Users-x`); we must NOT prepend
// one ourselves, because Windows paths start with a drive letter and have no
// leading separator (`E:\x` -> `E--x`, matching Claude Code), so an extra dash
// would mismatch the real on-disk folder and make detect() miss the project.
//
// The munge is ASCII-only by design — Claude Code uses `[^a-zA-Z0-9]`, which
// strips Unicode word characters (Vietnamese diacritics, CJK, …) to dashes too.
// We deliberately mirror that rather than preserve Unicode: a Unicode-preserving
// munge would NOT match the folder Claude actually writes, breaking detect() for
// every non-ASCII path.
//
// Long paths: Claude caps the name at 200 characters. A munged name longer than
// that is truncated to 200 chars and suffixed with `-<hash>`, where the hash is
// a 32-bit Java-style string hash (`h = h*31 + c`, kept signed via `| 0`) of the
// *original* (pre-munge) path, rendered in base36. Verified against the Claude
// Code binary (functions `ab` / `y$`, v2.1.x). We replicate it exactly so a
// deeply-nested or long-localized project still resolves to the right folder.
//
// Exported (pure, no realpath) so the encoding can be unit-tested with literal
// paths on any OS — notably the Windows drive-letter case the leading-dash bug
// used to break.
const CLAUDE_PROJECT_DIR_CAP = 200;

function claudeStringHash(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
	}
	return hash;
}

export function claudeProjectDirName(realCwd: string): string {
	const munged = realCwd.replace(/[^a-zA-Z0-9]/g, "-");
	if (munged.length <= CLAUDE_PROJECT_DIR_CAP) return munged;
	// Hash the same (realpath-resolved) string we munge — the closest we can get
	// to Claude's input without knowing whether it realpaths its own cwd. For the
	// common case (realpath == cwd) the suffix matches byte-for-byte.
	const suffix = Math.abs(claudeStringHash(realCwd)).toString(36);
	return `${munged.slice(0, CLAUDE_PROJECT_DIR_CAP)}-${suffix}`;
}

function mungeCwd(cwd: string): string {
	let real: string;
	try {
		real = realpathSync(cwd);
	} catch {
		real = cwd;
	}
	return claudeProjectDirName(real);
}

function projectDir(cwd: string): string {
	return join(homedir(), ".claude", "projects", mungeCwd(cwd));
}

interface RawRecord {
	type?: string;
	timestamp?: string;
	sessionId?: string;
	aiTitle?: string;
	// Marks records belonging to a subagent's own conversation. Claude Code
	// writes the subagent transcript into the parent's session file (sharing
	// the sessionId) flagged with isSidechain. We fold subagents into the
	// parent — the parent's main chain already carries the `Task` spawn and its
	// result — so sidechain records are skipped to avoid double-counting the
	// subagent's internal turns and tool calls.
	isSidechain?: boolean;
	message?: {
		role?: string;
		content?: unknown;
		model?: string;
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object") {
			const obj = item as Record<string, unknown>;
			if (obj.type === "text" && typeof obj.text === "string") {
				parts.push(obj.text);
			}
		}
	}
	return parts.join("\n");
}

interface ParsedToolResult {
	toolUseId: string;
	isError: boolean;
	content: string;
}

function parseToolResults(content: unknown): ParsedToolResult[] {
	if (!Array.isArray(content)) return [];
	const results: ParsedToolResult[] = [];
	for (const item of content) {
		if (item && typeof item === "object") {
			const obj = item as Record<string, unknown>;
			if (obj.type === "tool_result") {
				const toolUseId =
					typeof obj.tool_use_id === "string" ? obj.tool_use_id : "";
				const isError = !!obj.is_error;
				let text = "";
				const innerContent = obj.content;
				if (typeof innerContent === "string") {
					text = innerContent;
				} else if (Array.isArray(innerContent)) {
					const parts: string[] = [];
					for (const innerItem of innerContent) {
						if (innerItem && typeof innerItem === "object") {
							const innerObj = innerItem as Record<string, unknown>;
							if (
								innerObj.type === "text" &&
								typeof innerObj.text === "string"
							) {
								parts.push(innerObj.text);
							} else if (typeof innerObj.text === "string") {
								parts.push(innerObj.text);
							}
						} else if (typeof innerItem === "string") {
							parts.push(innerItem);
						}
					}
					text = parts.join("\n");
				} else if (typeof obj.text === "string") {
					text = obj.text;
				}
				results.push({ toolUseId, isError, content: text });
			}
		}
	}
	return results;
}

// Total characters a record's content carried — used to roll subagent
// (sidechain) turns into the parent's subagentChars* without rendering them,
// mirroring the OpenCode descendant rollup. Sums every text-bearing block
// (text, thinking, tool-call input, tool-result output) so the estimate
// reflects the subagent's full volume, not just its visible text.
function contentCharCount(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = extractText(content).length;
	for (const result of parseToolResults(content))
		total += result.content.length;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		if (obj.type === "thinking" && typeof obj.thinking === "string") {
			total += obj.thinking.length;
		} else if (
			obj.type === "tool_use" &&
			obj.input &&
			typeof obj.input === "object"
		) {
			total += JSON.stringify(obj.input).length;
		}
	}
	return total;
}

async function parseSessionFile(filePath: string): Promise<Session | null> {
	const raw = await readFile(filePath, "utf-8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return null;

	let sessionId = "";
	let aiTitle = "";
	let createdAt: Date | null = null;
	let updatedAt: Date | null = null;
	const messages: Message[] = [];
	let firstUserMessage = "";
	let subagentCharsIn = 0;
	let subagentCharsOut = 0;

	let activeAssistantContent = "";
	let activeAssistantTimestamp: string | undefined;
	let activeAssistantModel: string | undefined;

	const pendingToolUses = new Map<
		string,
		{ name: string; input: Record<string, unknown>; timestamp?: string }
	>();

	function appendContent(next: string) {
		if (!next) return;
		if (activeAssistantContent) {
			if (activeAssistantContent.endsWith("\n")) {
				activeAssistantContent += next;
			} else {
				activeAssistantContent += `\n\n${next}`;
			}
		} else {
			activeAssistantContent = next;
		}
	}

	function flushAssistant() {
		if (activeAssistantContent.trim()) {
			messages.push({
				role: "assistant",
				content: activeAssistantContent.trim(),
				timestamp: activeAssistantTimestamp,
				model: activeAssistantModel,
			});
		}
		activeAssistantContent = "";
		activeAssistantTimestamp = undefined;
		activeAssistantModel = undefined;
	}

	for (const line of lines) {
		let rec: RawRecord;
		try {
			rec = JSON.parse(line) as RawRecord;
		} catch {
			continue;
		}
		// Fold subagent turns into the parent: their content isn't rendered (the
		// parent's `Task` tool-use already shows the spawn + result), but their
		// character volume is rolled into subagentChars* so the parent reflects
		// the subagent's cost — matching the OpenCode descendant rollup. Bucket by
		// role: assistant output is "out", user/tool input is "in".
		if (rec.isSidechain === true) {
			const chars = contentCharCount(rec.message?.content);
			if (rec.message?.role === "assistant") subagentCharsOut += chars;
			else subagentCharsIn += chars;
			continue;
		}
		if (!sessionId && typeof rec.sessionId === "string") {
			sessionId = rec.sessionId;
		}
		// Claude Code appends an "ai-title" record each turn with the AI-generated
		// session title (same text shown in the sidebar). Keep the latest value —
		// the title can be updated as the conversation evolves.
		if (
			rec.type === "ai-title" &&
			typeof rec.aiTitle === "string" &&
			rec.aiTitle
		) {
			aiTitle = rec.aiTitle;
		}
		if (rec.timestamp) {
			const ts = new Date(rec.timestamp);
			if (!Number.isNaN(ts.getTime())) {
				if (!createdAt) createdAt = ts;
				updatedAt = ts;
			}
		}

		const content = rec.message?.content;
		const role = rec.message?.role;

		if (rec.type === "user" || role === "user") {
			// Walk blocks in order so a mixed [text, tool_result] (or the reverse)
			// renders both halves: tool_result blocks extend the current assistant
			// turn; text blocks flush it and push a user message.
			const toolResults = parseToolResults(content);
			for (const result of toolResults) {
				const toolUse = pendingToolUses.get(result.toolUseId);
				if (toolUse) {
					const formatted = renderToolUse(
						toolUse.name,
						toolUse.input,
						result.content,
						result.isError,
					);
					if (!activeAssistantTimestamp) {
						activeAssistantTimestamp = toolUse.timestamp || rec.timestamp;
					}
					appendContent(formatted);
					pendingToolUses.delete(result.toolUseId);
				}
			}
			const text = extractText(content);
			if (text) {
				flushAssistant();
				messages.push({
					role: "user",
					content: text,
					timestamp: rec.timestamp,
				});
				if (!firstUserMessage) firstUserMessage = text;
			}
		} else if (rec.type === "assistant" || role === "assistant") {
			if (!activeAssistantTimestamp) {
				activeAssistantTimestamp = rec.timestamp;
			}
			// Sticky-first: a Claude Code assistant turn can span multiple JSONL
			// records (text + thinking + tool_use chunks), but `model` is the
			// same on every chunk of one turn. Locking in the first observed
			// model is simpler than reconciling per-chunk values and avoids
			// flipping the recorded model if a chunk omits the field.
			if (!activeAssistantModel && rec.message?.model) {
				activeAssistantModel = rec.message.model;
			}

			if (typeof content === "string") {
				appendContent(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object") {
						const obj = block as Record<string, unknown>;
						if (obj.type === "text" && typeof obj.text === "string") {
							appendContent(obj.text);
						} else if (
							obj.type === "thinking" &&
							typeof obj.thinking === "string"
						) {
							if (obj.thinking.trim()) {
								appendContent(
									`<details><summary>Thought</summary>\n\n${obj.thinking.trim()}\n</details>\n`,
								);
							}
						} else if (obj.type === "tool_use") {
							const id = typeof obj.id === "string" ? obj.id : "";
							const name = typeof obj.name === "string" ? obj.name : "";
							const input =
								obj.input && typeof obj.input === "object"
									? (obj.input as Record<string, unknown>)
									: {};
							if (id && name) {
								pendingToolUses.set(id, {
									name,
									input,
									timestamp: rec.timestamp,
								});
							}
						}
					}
				}
			}
		}
	}

	for (const toolUse of pendingToolUses.values()) {
		const formatted = renderToolUse(
			toolUse.name,
			toolUse.input,
			"Tool execution aborted (no result recorded)",
			true,
			true,
		);
		if (!activeAssistantTimestamp) {
			activeAssistantTimestamp = toolUse.timestamp;
		}
		appendContent(formatted);
	}

	flushAssistant();

	if (messages.length === 0 || !sessionId || !createdAt) return null;
	return {
		id: sessionId,
		agent: "claude-code",
		createdAt,
		updatedAt: updatedAt ?? createdAt,
		title: aiTitle || undefined,
		firstUserMessage,
		messages,
		...(subagentCharsIn > 0 || subagentCharsOut > 0
			? { subagentCharsIn, subagentCharsOut }
			: {}),
	};
}

export const claudeCodeProvider: Provider = {
	agent: "claude-code",

	describeTarget(cwd: string): string {
		return projectDir(cwd);
	},

	async detect(cwd: string): Promise<boolean> {
		const dir = projectDir(cwd);
		try {
			return existsSync(dir) && statSync(dir).isDirectory();
		} catch {
			return false;
		}
	},

	async listSessions(cwd: string): Promise<Session[]> {
		const dir = projectDir(cwd);
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return [];
		}
		const sessions: Session[] = [];
		for (const name of entries) {
			if (!name.endsWith(".jsonl")) continue;
			try {
				const session = await parseSessionFile(join(dir, name));
				if (session) sessions.push(session);
			} catch {
				// Skip malformed files; one bad file shouldn't kill the whole export.
			}
		}
		return sessions;
	},
};
