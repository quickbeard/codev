import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffFromEditInput, textValue } from "@/lib/diff.js";
import { codeFence } from "@/lib/markdown.js";
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
	aiTitle?: string;
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

function filePathFromInput(input: Record<string, unknown>): string {
	return (
		textValue(input.file_path) ||
		textValue(input.filePath) ||
		textValue(input.path)
	);
}

// `aborted` distinguishes an orphan tool_use (no result line ever arrived,
// e.g. the session was interrupted) from a tool_use whose result came back
// with `is_error: true` (the user rejected the edit, or the tool itself
// failed). Edit-acceptance analytics need to keep those apart: an aborted
// edit isn't a refused edit.
//
// `name` keeps its original casing in the human-readable summary so
// "Edit" and "Read" still render naturally. The `data-tool-name` attribute
// is lowercased for downstream consumers that key on the slug.
function formatToolUse(
	name: string,
	input: Record<string, unknown>,
	output: string,
	isError: boolean,
	aborted = false,
): string {
	const toolName = name.toLowerCase();
	let toolType = "tool";
	let summary = `Call tool: ${name}`;
	let body = "";

	if (
		toolName === "bash" ||
		toolName === "shell" ||
		toolName === "run_command" ||
		toolName === "exec_command"
	) {
		toolType = "shell";
		const cmd =
			typeof input.command === "string"
				? input.command
				: typeof input.cmd === "string"
					? input.cmd
					: "";
		summary = `Run command: ${cmd}`;
		body = codeFence(
			`$ ${cmd}\n${isError ? `Error: ${output}` : output}`,
			"bash",
		);
	} else if (
		toolName === "view" ||
		toolName === "read" ||
		toolName === "read_file" ||
		toolName === "view_file"
	) {
		toolType = "read";
		const path = filePathFromInput(input);
		summary = `Read file: ${path}`;
		body = isError ? `Error: ${output}` : output;
	} else if (toolName === "glob" || toolName === "glob_files") {
		toolType = "glob";
		const pattern =
			typeof input.pattern === "string"
				? input.pattern
				: typeof input.globPattern === "string"
					? input.globPattern
					: "";
		summary = `Glob files: ${pattern}`;
		body = codeFence(
			`Pattern: ${pattern}\nMatches:\n${isError ? `Error: ${output}` : output}`,
		);
	} else if (toolName === "grep" || toolName === "grep_search") {
		toolType = "grep";
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		const path = typeof input.path === "string" ? input.path : "";
		summary = `Grep search: ${pattern}`;
		body = codeFence(
			`Pattern: ${pattern}\nPath: ${path}\nMatches:\n${isError ? `Error: ${output}` : output}`,
		);
	} else if (
		toolName === "write" ||
		toolName === "write_file" ||
		toolName === "save_file"
	) {
		toolType = "write";
		const path = filePathFromInput(input);
		const content = typeof input.content === "string" ? input.content : "";
		summary = `Edit file: ${path}`;
		body = isError ? `Error: ${output}` : content ? codeFence(content) : output;
	} else if (
		toolName === "edit" ||
		toolName === "replace_file_content" ||
		toolName === "multi_replace_file_content" ||
		toolName === "edit_file"
	) {
		toolType = "write";
		const path = filePathFromInput(input) || textValue(input.TargetFile);
		summary = `Edit file: ${path}`;
		const diff = diffFromEditInput(input);
		if (isError) {
			body = diff
				? `${codeFence(diff, "diff")}\n\nError: ${output}`
				: `Error: ${output}`;
		} else {
			body = diff
				? `${codeFence(diff, "diff")}\n\n${output}`
				: output.includes("<<<") ||
						output.includes("---") ||
						output.includes("+++")
					? codeFence(output, "diff")
					: codeFence(output);
		}
	} else if (
		toolName === "agent" ||
		toolName === "task" ||
		toolName === "invoke_subagent" ||
		toolName === "subagent"
	) {
		toolType = "task";
		const desc = typeof input.description === "string" ? input.description : "";
		const prompt = typeof input.prompt === "string" ? input.prompt : "";
		summary = `Spawn subagent: ${desc || name}`;
		body = `**Prompt**:\n${prompt}\n\n**Result**:\n${isError ? `Error: ${output}` : output}`;
	} else {
		summary = `Call tool: ${name}`;
		body = `**Input**:\n${codeFence(JSON.stringify(input, null, 2), "json")}\n\n**Output**:\n${isError ? `Error: ${output}` : output}`;
	}

	const editStatus =
		toolType === "write"
			? ` data-edit-status="${aborted ? "aborted" : isError ? "rejected" : "accepted"}"`
			: "";
	return `<tool-use data-tool-type="${toolType}" data-tool-name="${toolName}"${editStatus}>\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
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
					const formatted = formatToolUse(
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
		const formatted = formatToolUse(
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
