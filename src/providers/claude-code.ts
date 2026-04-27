import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, Provider, Session } from "@/providers/types.js";

// Claude Code stores sessions under ~/.claude/projects/<munged-cwd>/, where the
// directory name is the absolute (symlink-resolved) cwd with every
// non-alphanumeric character replaced by a dash, prefixed with a leading dash.
function mungeCwd(cwd: string): string {
	let real: string;
	try {
		real = realpathSync(cwd);
	} catch {
		real = cwd;
	}
	const dashed = real.replace(/[^a-zA-Z0-9-]/g, "-");
	return dashed.startsWith("-") ? dashed : `-${dashed}`;
}

function projectDir(cwd: string): string {
	return join(homedir(), ".claude", "projects", mungeCwd(cwd));
}

interface RawRecord {
	type?: string;
	timestamp?: string;
	sessionId?: string;
	message?: {
		role?: string;
		content?: unknown;
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

function isToolResultContent(content: unknown): boolean {
	if (!Array.isArray(content) || content.length === 0) return false;
	const first = content[0];
	if (!first || typeof first !== "object") return false;
	return (first as { type?: string }).type === "tool_result";
}

async function parseSessionFile(filePath: string): Promise<Session | null> {
	const raw = await Bun.file(filePath).text();
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return null;

	let sessionId = "";
	let createdAt: Date | null = null;
	let updatedAt: Date | null = null;
	const messages: Message[] = [];
	let firstUserMessage = "";

	for (const line of lines) {
		let rec: RawRecord;
		try {
			rec = JSON.parse(line) as RawRecord;
		} catch {
			continue;
		}
		if (!sessionId && typeof rec.sessionId === "string") {
			sessionId = rec.sessionId;
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
		const text = extractText(content);
		if (!text) continue;

		if (rec.type === "user") {
			// Skip tool-result messages — they're agent-internal turns, not user input.
			if (isToolResultContent(content)) continue;
			messages.push({ role: "user", content: text, timestamp: rec.timestamp });
			if (!firstUserMessage) firstUserMessage = text;
		} else if (rec.type === "assistant" || role === "assistant") {
			messages.push({
				role: "assistant",
				content: text,
				timestamp: rec.timestamp,
			});
		}
	}

	if (messages.length === 0 || !sessionId || !createdAt) return null;
	return {
		id: sessionId,
		agent: "claude-code",
		createdAt,
		updatedAt: updatedAt ?? createdAt,
		firstUserMessage,
		messages,
	};
}

export const claudeCodeProvider: Provider = {
	agent: "claude-code",

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
