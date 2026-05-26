import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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

function formatCodexToolUse(
	name: string,
	input: Record<string, unknown>,
	output: string,
	isError: boolean,
): string {
	const toolName = name.toLowerCase();
	let toolType = "tool";
	let summary = `Call tool: ${name}`;
	let body = "";
	const editDiff = diffFromEditInput(input);

	if (
		toolName === "exec_command" ||
		toolName === "bash" ||
		toolName === "shell"
	) {
		toolType = "shell";
		const cmd =
			typeof input.cmd === "string"
				? input.cmd
				: typeof input.command === "string"
					? input.command
					: "";
		summary = `Run command: ${cmd}`;
		body = `\`\`\`bash\n$ ${cmd}\n${isError ? `Error: ${output}` : output}\n\`\`\``;
	} else if (
		toolName === "read_file" ||
		toolName === "read" ||
		toolName === "view_file"
	) {
		toolType = "read";
		const path =
			typeof input.filePath === "string"
				? input.filePath
				: typeof input.path === "string"
					? input.path
					: "";
		summary = `Read file: ${path}`;
		body = isError ? `Error: ${output}` : output;
	} else if (toolName === "grep" || toolName === "grep_search") {
		toolType = "grep";
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		const path = typeof input.path === "string" ? input.path : "";
		summary = `Grep search: ${pattern}`;
		body = `\`\`\`\nPattern: ${pattern}\nPath: ${path}\nMatches:\n${isError ? `Error: ${output}` : output}\n\`\`\``;
	} else if (toolName === "write_file" || toolName === "write") {
		toolType = "write";
		const path =
			typeof input.filePath === "string"
				? input.filePath
				: typeof input.path === "string"
					? input.path
					: "";
		const content = typeof input.content === "string" ? input.content : "";
		summary = `Edit file: ${path}`;
		body = isError
			? `Error: ${output}`
			: content
				? `\`\`\`\n${content}\n\`\`\``
				: output;
	} else if (
		toolName === "replace_file_content" ||
		toolName === "edit" ||
		toolName === "multi_replace_file_content"
	) {
		toolType = "write";
		const path =
			typeof input.TargetFile === "string"
				? input.TargetFile
				: typeof input.filePath === "string"
					? input.filePath
					: typeof input.path === "string"
						? input.path
						: "";
		summary = `Edit file: ${path}`;
		body = editDiff
			? `\`\`\`diff\n${editDiff}\n\`\`\`\n\n${isError ? `Error: ${output}` : output}`
			: isError
				? `Error: ${output}`
				: output.includes("<<<") ||
						output.includes("---") ||
						output.includes("+++")
					? `\`\`\`diff\n${output}\n\`\`\``
					: `\`\`\`\n${output}\n\`\`\``;
	} else if (
		toolName === "subagent" ||
		toolName === "invoke_subagent" ||
		toolName === "task"
	) {
		toolType = "task";
		const desc = typeof input.description === "string" ? input.description : "";
		const prompt = typeof input.prompt === "string" ? input.prompt : "";
		summary = `Spawn subagent: ${desc || name}`;
		body = `**Prompt**:\n${prompt}\n\n**Result**:\n${isError ? `Error: ${output}` : output}`;
	} else {
		summary = `Call tool: ${name}`;
		body = `**Input**:\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n**Output**:\n${isError ? `Error: ${output}` : output}`;
	}

	const editStatus =
		toolType === "write"
			? ` data-edit-status="${isError ? "rejected" : "accepted"}"`
			: "";
	return `<tool-use data-tool-type="${toolType}" data-tool-name="${toolName}"${editStatus}>\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
}

function extractPatchFilePath(patch: string): string {
	const match =
		patch.match(/^\*\*\* Update File:\s*(.+)$/m) ??
		patch.match(/^\*\*\* Add File:\s*(.+)$/m) ??
		patch.match(/^---\s+a\/(.+)$/m) ??
		patch.match(/^\+\+\+\s+b\/(.+)$/m);
	return match?.[1]?.trim() ?? "";
}

function buildLineDiff(oldText: string, newText: string): string {
	const lines: string[] = [];
	for (const line of oldText.split("\n")) lines.push(`-${line}`);
	for (const line of newText.split("\n")) lines.push(`+${line}`);
	return lines.join("\n");
}

function diffFromEditInput(input: Record<string, unknown>): string {
	const oldText =
		typeof input.old_string === "string"
			? input.old_string
			: typeof input.oldString === "string"
				? input.oldString
				: "";
	const newText =
		typeof input.new_string === "string"
			? input.new_string
			: typeof input.newString === "string"
				? input.newString
				: "";
	if (!oldText && !newText) return "";
	return buildLineDiff(oldText, newText);
}

function formatCodexCustomToolUse(
	name: string,
	input: unknown,
	output: string,
	isError: boolean,
): string {
	const toolName = name.toLowerCase();
	if (toolName === "apply_patch") {
		const patch = typeof input === "string" ? input : "";
		const path = extractPatchFilePath(patch);
		const body = `\`\`\`diff\n${patch}\n\`\`\`\n\n${isError ? `Error: ${output}` : output}`;
		return `<tool-use data-tool-type="write" data-tool-name="${toolName}" data-edit-status="${isError ? "rejected" : "accepted"}">\n<details>\n<summary>Edit file: ${path}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
	}

	const body = `**Input**:\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n**Output**:\n${isError ? `Error: ${output}` : output}`;
	return `<tool-use data-tool-type="tool" data-tool-name="${toolName}">\n<details>\n<summary>Call tool: ${name}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value : "";
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
					if (!activeAssistantModel && pendingTurnModel)
						activeAssistantModel = pendingTurnModel;
					appendContent(content);
				}
			} else if (ptype === "agent_reasoning") {
				const text = (
					textValue(payload.text) || textValue(payload.message)
				).trim();
				if (text) {
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = recTimestamp;
					if (!activeAssistantModel && pendingTurnModel)
						activeAssistantModel = pendingTurnModel;
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
					if (!activeAssistantModel && pendingTurnModel)
						activeAssistantModel = pendingTurnModel;
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
					if (!activeAssistantModel && pendingTurnModel)
						activeAssistantModel = pendingTurnModel;
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
					const formatted = formatCodexToolUse(
						toolUse.name,
						toolUse.arguments,
						output,
						isError,
					);
					if (!activeAssistantTimestamp)
						activeAssistantTimestamp = toolUse.timestamp || recTimestamp;
					if (!activeAssistantModel && pendingTurnModel)
						activeAssistantModel = pendingTurnModel;
					appendContent(formatted);
					pendingToolUses.delete(callId);
				} else {
					const formatted = `<tool-use data-tool-type="tool" data-tool-name="generic">\n<details>\n<summary>Tool output</summary>\n\n${output}\n</details>\n</tool-use>\n`;
					appendContent(formatted);
				}
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
					if (!activeAssistantModel && pendingTurnModel)
						activeAssistantModel = pendingTurnModel;
					appendContent(formatted);
					pendingCustomToolUses.delete(callId);
				}
			}
		}
	}

	for (const toolUse of pendingToolUses.values()) {
		const formatted = formatCodexToolUse(
			toolUse.name,
			toolUse.arguments,
			"Tool execution aborted (no result recorded)",
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
