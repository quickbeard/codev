import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, Provider, Session } from "@/providers/types.js";

function sessionsRoot(): string {
	return join(homedir(), ".codex", "sessions");
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

interface CodexMeta {
	type?: string;
	timestamp?: string;
	payload?: {
		id?: string;
		timestamp?: string;
		cwd?: string;
	};
}

interface CodexEvent {
	type?: string;
	timestamp?: string;
	payload?: {
		type?: string;
		message?: string;
		text?: string;
	};
}

interface CodexPreview {
	id: string;
	cwd: string;
	createdAt: Date;
	path: string;
}

async function readMeta(filePath: string): Promise<CodexMeta | null> {
	try {
		const text = await Bun.file(filePath).text();
		const firstLine = text.split("\n", 1)[0];
		if (!firstLine) return null;
		return JSON.parse(firstLine) as CodexMeta;
	} catch {
		return null;
	}
}

// Walks ~/.codex/sessions/YYYY/MM/DD/*.jsonl and returns lightweight info for
// sessions whose first-line metadata records a cwd matching `cwd`.
async function findSessions(cwd: string): Promise<CodexPreview[]> {
	const root = sessionsRoot();
	if (!existsSync(root)) return [];
	const targetCwd = canonical(cwd);
	const result: CodexPreview[] = [];

	let years: string[];
	try {
		years = await readdir(root);
	} catch {
		return [];
	}
	for (const year of years) {
		if (!/^\d{4}$/.test(year)) continue;
		const yearPath = join(root, year);
		let months: string[];
		try {
			months = await readdir(yearPath);
		} catch {
			continue;
		}
		for (const month of months) {
			const monthPath = join(yearPath, month);
			let days: string[];
			try {
				days = await readdir(monthPath);
			} catch {
				continue;
			}
			for (const day of days) {
				const dayPath = join(monthPath, day);
				let files: string[];
				try {
					files = await readdir(dayPath);
				} catch {
					continue;
				}
				for (const file of files) {
					if (!file.endsWith(".jsonl")) continue;
					const filePath = join(dayPath, file);
					const meta = await readMeta(filePath);
					const id = meta?.payload?.id;
					const sessionCwd = meta?.payload?.cwd;
					if (!id || !sessionCwd) continue;
					const sessionCanonical = canonical(sessionCwd);
					if (
						sessionCanonical !== targetCwd &&
						sessionCanonical.toLowerCase() !== targetCwd.toLowerCase()
					) {
						continue;
					}
					const createdAt = new Date(
						meta?.payload?.timestamp ?? meta?.timestamp ?? Date.now(),
					);
					result.push({ id, cwd: sessionCwd, createdAt, path: filePath });
				}
			}
		}
	}
	return result;
}

async function parseSession(preview: CodexPreview): Promise<Session | null> {
	const text = await Bun.file(preview.path).text();
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length <= 1) return null; // only metadata, no events

	const messages: Message[] = [];
	let firstUserMessage = "";
	let updatedAt: Date | null = preview.createdAt;

	// Skip the first line (metadata) — already consumed in readMeta.
	for (let i = 1; i < lines.length; i++) {
		const raw = lines[i];
		if (!raw) continue;
		let rec: CodexEvent;
		try {
			rec = JSON.parse(raw) as CodexEvent;
		} catch {
			continue;
		}
		if (rec.type !== "event_msg") continue;
		const payload = rec.payload;
		if (!payload) continue;
		const ptype = payload.type;
		const content = (payload.message ?? payload.text ?? "").trim();
		if (!content) continue;
		if (rec.timestamp) {
			const ts = new Date(rec.timestamp);
			if (!Number.isNaN(ts.getTime())) updatedAt = ts;
		}
		if (ptype === "user_message") {
			messages.push({ role: "user", content, timestamp: rec.timestamp });
			if (!firstUserMessage) firstUserMessage = content;
		} else if (ptype === "agent_message") {
			messages.push({ role: "assistant", content, timestamp: rec.timestamp });
		}
	}

	if (messages.length === 0) return null;
	return {
		id: preview.id,
		agent: "codex",
		createdAt: preview.createdAt,
		updatedAt: updatedAt ?? preview.createdAt,
		firstUserMessage,
		messages,
	};
}

export const codexProvider: Provider = {
	agent: "codex",

	async detect(cwd: string): Promise<boolean> {
		const root = sessionsRoot();
		try {
			if (!existsSync(root) || !statSync(root).isDirectory()) return false;
		} catch {
			return false;
		}
		const previews = await findSessions(cwd);
		return previews.length > 0;
	},

	async listSessions(cwd: string): Promise<Session[]> {
		const previews = await findSessions(cwd);
		const sessions: Session[] = [];
		for (const preview of previews) {
			try {
				const session = await parseSession(preview);
				if (session) sessions.push(session);
			} catch {
				// Tolerate one bad session.
			}
		}
		return sessions;
	},
};
