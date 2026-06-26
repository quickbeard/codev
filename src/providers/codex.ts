import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { textValue } from "@/lib/diff.js";
import { codeFence } from "@/lib/markdown.js";
import { renderToolUse } from "@/lib/tool-render.js";
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

interface CodexPreview {
	id: string;
	cwd: string;
	createdAt: Date;
	path: string;
}

async function readMeta(filePath: string): Promise<CodexMeta | null> {
	try {
		const text = await readFile(filePath, "utf-8");
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

// Collect every file path mentioned in the patch. apply_patch can touch
// multiple files; previously we only surfaced the first one in the summary.
function extractPatchFilePaths(patch: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const patterns = [
		/^\*\*\* Update File:\s*(.+)$/gm,
		/^\*\*\* Add File:\s*(.+)$/gm,
		/^---\s+a\/(.+)$/gm,
		/^\+\+\+\s+b\/(.+)$/gm,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null = re.exec(patch);
		while (m !== null) {
			const p = m[1]?.trim();
			if (p && !seen.has(p)) {
				seen.add(p);
				paths.push(p);
			}
			m = re.exec(patch);
		}
	}
	return paths;
}

function formatCodexCustomToolUse(
	name: string,
	input: unknown,
	output: string,
	isError: boolean,
	aborted = false,
): string {
	const toolName = name.toLowerCase();
	if (toolName === "apply_patch") {
		const patch = typeof input === "string" ? input : "";
		const paths = extractPatchFilePaths(patch);
		const pathSummary = paths.length > 0 ? paths.join(", ") : "";
		const body = `${codeFence(patch, "diff")}\n\n${isError ? `Error: ${output}` : output}`;
		const editStatus = aborted ? "aborted" : isError ? "rejected" : "accepted";
		return `<tool-use data-tool-type="write" data-tool-name="${toolName}" data-edit-status="${editStatus}">\n<details>\n<summary>Edit file: ${pathSummary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
	}

	const body = `**Input**:\n${codeFence(JSON.stringify(input, null, 2), "json")}\n\n**Output**:\n${isError ? `Error: ${output}` : output}`;
	return `<tool-use data-tool-type="tool" data-tool-name="${toolName}">\n<details>\n<summary>Call tool: ${name}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
}

async function parseSession(preview: CodexPreview): Promise<Session | null> {
	const text = await readFile(preview.path, "utf-8");
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length <= 1) return null; // only metadata, no events

	const messages: Message[] = [];
	let firstUserMessage = "";
	let updatedAt: Date | null = preview.createdAt;

	let activeAssistantContent = "";
	let activeAssistantTimestamp: string | undefined;
	let activeAssistantModel: string | undefined;
	// Model captured from turn_context (emitted before each user_message).
	// Stored separately so flushAssistant() can use the model that was active
	// for the turn being flushed, not the one for the upcoming turn.
	let pendingTurnModel: string | undefined;

	const pendingToolUses = new Map<
		string,
		{ name: string; arguments: Record<string, unknown>; timestamp?: string }
	>();
	const pendingCustomToolUses = new Map<
		string,
		{ name: string; input: unknown; timestamp?: string }
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

	// Attach pendingTurnModel to the active assistant turn AND clear it. The
	// clear is what makes a missing turn_context on a later turn safe: without
	// it, a turn with no turn_context would silently inherit the prior turn's
	// model. Sticky-first within a turn is preserved by the
	// `if (!activeAssistantModel)` guard each caller does before calling.
	function consumeTurnModel() {
		if (!activeAssistantModel && pendingTurnModel) {
			activeAssistantModel = pendingTurnModel;
		}
		pendingTurnModel = undefined;
	}

	// Skip the first line (metadata) — already consumed in readMeta.
	for (let i = 1; i < lines.length; i++) {
		const raw = lines[i];
		if (!raw) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(raw);
		} catch {
			continue;
		}

		const recTimestamp = textValue(rec.timestamp) || undefined;
		if (recTimestamp) {
			const ts = new Date(recTimestamp);
			if (!Number.isNaN(ts.getTime())) updatedAt = ts;
		}

		const type = rec.type;
		const payload =
			rec.payload && typeof rec.payload === "object"
				? (rec.payload as Record<string, unknown>)
				: {};
		const ptype = payload.type;

		if (type === "turn_context") {
			// turn_context is emitted once per turn, before the user_message event.
			// Capture payload.model so it can be attached to the assistant turn that
			// follows after the user message is flushed.
			const m = typeof payload.model === "string" ? payload.model : undefined;
			if (m) pendingTurnModel = m;
		} else if (type === "event_msg") {
			if (ptype === "user_message") {
				flushAssistant();
				const content = (
					textValue(payload.message) || textValue(payload.text)
				).trim();
				if (content) {
					messages.push({ role: "user", content, timestamp: recTimestamp });
					if (!firstUserMessage) firstUserMessage = content;
				}
			} else if (ptype === "agent_message") {
				const content = (
					textValue(payload.message) || textValue(payload.text)
				).trim();
				if (content) {
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = recTimestamp;
					consumeTurnModel();
					appendContent(content);
				}
			} else if (ptype === "agent_reasoning") {
				const text = (
					textValue(payload.text) || textValue(payload.message)
				).trim();
				if (text) {
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = recTimestamp;
					consumeTurnModel();
					appendContent(
						`<details><summary>Thought</summary>\n\n${text}\n</details>\n`,
					);
				}
			}
		} else if (type === "response_item") {
			if (ptype === "reasoning") {
				// The reasoning field may be encrypted in some versions (encrypted_content),
				// but plaintext is in payload.content or summary if available.
				const contentText =
					typeof payload.content === "string" ? payload.content.trim() : "";
				const summaryText = Array.isArray(payload.summary)
					? payload.summary.join("\n").trim()
					: "";
				const thought = contentText || summaryText;
				if (thought) {
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = recTimestamp;
					consumeTurnModel();
					appendContent(
						`<details><summary>Thought</summary>\n\n${thought}\n</details>\n`,
					);
				}
			} else if (ptype === "message") {
				const content = (
					textValue(payload.message) || textValue(payload.text)
				).trim();
				if (content) {
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = recTimestamp;
					consumeTurnModel();
					appendContent(content);
				}
			} else if (ptype === "function_call") {
				const callId = textValue(payload.call_id);
				const name = textValue(payload.name);
				let args: Record<string, unknown> = {};
				if (typeof payload.arguments === "string") {
					try {
						args = JSON.parse(payload.arguments);
					} catch {
						args = { rawArguments: payload.arguments };
					}
				} else if (payload.arguments && typeof payload.arguments === "object") {
					args = payload.arguments as Record<string, unknown>;
				}
				if (callId && name) {
					pendingToolUses.set(callId, {
						name,
						arguments: args,
						timestamp: recTimestamp,
					});
				}
			} else if (ptype === "function_call_output") {
				const callId = textValue(payload.call_id);
				const toolUse = pendingToolUses.get(callId);
				let output = typeof payload.output === "string" ? payload.output : "";
				// Strip system prefix from output if exists for cleaner logs
				if (output.startsWith("Chunk ID:") && output.includes("Output:\n")) {
					const index = output.indexOf("Output:\n");
					output = output.substring(index + "Output:\n".length);
				}
				const isError =
					typeof payload.is_error === "boolean" ? payload.is_error : false;
				if (toolUse) {
					const formatted = renderToolUse(
						toolUse.name,
						toolUse.arguments,
						output,
						isError,
					);
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = toolUse.timestamp || recTimestamp;
					consumeTurnModel();
					appendContent(formatted);
					pendingToolUses.delete(callId);
				}
				// Unmatched function_call_output: the paired function_call is
				// missing (truncated log, schema drift). Drop silently rather
				// than emit a placeholder envelope whose data-tool-name slug
				// would pollute analytics.
			} else if (ptype === "custom_tool_call") {
				const callId = textValue(payload.call_id);
				const name = textValue(payload.name);
				if (callId && name) {
					pendingCustomToolUses.set(callId, {
						name,
						input: payload.input,
						timestamp: recTimestamp,
					});
				}
			} else if (ptype === "custom_tool_call_output") {
				const callId = textValue(payload.call_id);
				const toolUse = pendingCustomToolUses.get(callId);
				const output = typeof payload.output === "string" ? payload.output : "";
				const isError =
					typeof payload.is_error === "boolean" ? payload.is_error : false;
				if (toolUse) {
					const formatted = formatCodexCustomToolUse(
						toolUse.name,
						toolUse.input,
						output,
						isError,
					);
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = toolUse.timestamp || recTimestamp;
					consumeTurnModel();
					appendContent(formatted);
					pendingCustomToolUses.delete(callId);
				}
			}
		}
	}

	for (const toolUse of pendingToolUses.values()) {
		const formatted = renderToolUse(
			toolUse.name,
			toolUse.arguments,
			"Tool execution aborted (no result recorded)",
			true,
			true,
		);
		if (!activeAssistantTimestamp) activeAssistantTimestamp = toolUse.timestamp;
		appendContent(formatted);
	}

	for (const toolUse of pendingCustomToolUses.values()) {
		const formatted = formatCodexCustomToolUse(
			toolUse.name,
			toolUse.input,
			"Tool execution aborted (no result recorded)",
			true,
			true,
		);
		if (!activeAssistantTimestamp) activeAssistantTimestamp = toolUse.timestamp;
		appendContent(formatted);
	}

	flushAssistant();

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

	// Codex doesn't key sessions by a per-project folder — it scans every file
	// under the sessions root and filters by the cwd recorded inside. The root is
	// the only meaningful location to report.
	describeTarget(_cwd: string): string {
		return sessionsRoot();
	},

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
