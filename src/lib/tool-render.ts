// Shared tool-use renderer for the Claude Code and Codex providers. Both
// providers receive a (name, input, output, isError) tuple per tool call and
// emit the same `<tool-use data-…>` envelope — only the alias sets differ
// across schemas. Provider-specific quirks (Codex `apply_patch`, OpenCode's
// `state.metadata` diffs) stay in the provider files.

import {
	diffFromEditInput,
	diffFromWriteContent,
	textValue,
} from "@/lib/diff.js";
import { codeFence } from "@/lib/markdown.js";

const SHELL_NAMES = new Set(["bash", "shell", "run_command", "exec_command"]);
const READ_NAMES = new Set(["view", "read", "read_file", "view_file"]);
const GLOB_NAMES = new Set(["glob", "glob_files"]);
const GREP_NAMES = new Set(["grep", "grep_search"]);
const WRITE_NAMES = new Set(["write", "write_file", "save_file"]);
const EDIT_NAMES = new Set([
	"edit",
	"edit_file",
	"replace_file_content",
	"multi_replace_file_content",
]);
const TASK_NAMES = new Set(["agent", "task", "invoke_subagent", "subagent"]);

// Union of every file-path key any supported schema uses. Order is short-
// circuit precedence; in practice only one key is set per call so the order
// matters only when an input duplicates the path.
function filePathFromInput(input: Record<string, unknown>): string {
	return (
		textValue(input.file_path) ||
		textValue(input.filePath) ||
		textValue(input.path) ||
		textValue(input.TargetFile)
	);
}

export function renderToolUse(
	name: string,
	input: Record<string, unknown>,
	output: string,
	isError: boolean,
	aborted = false,
): string {
	const toolName = name.toLowerCase();
	let toolType = "tool";
	let summary = `Call tool: ${name}`;
	let body = `**Input**:\n${codeFence(JSON.stringify(input, null, 2), "json")}\n\n**Output**:\n${isError ? `Error: ${output}` : output}`;

	if (SHELL_NAMES.has(toolName)) {
		toolType = "shell";
		const cmd = textValue(input.command) || textValue(input.cmd);
		summary = `Run command: ${cmd}`;
		body = codeFence(
			`$ ${cmd}\n${isError ? `Error: ${output}` : output}`,
			"bash",
		);
	} else if (READ_NAMES.has(toolName)) {
		toolType = "read";
		summary = `Read file: ${filePathFromInput(input)}`;
		body = isError ? `Error: ${output}` : output;
	} else if (GLOB_NAMES.has(toolName)) {
		toolType = "glob";
		const pattern = textValue(input.pattern) || textValue(input.globPattern);
		summary = `Glob files: ${pattern}`;
		body = codeFence(
			`Pattern: ${pattern}\nMatches:\n${isError ? `Error: ${output}` : output}`,
		);
	} else if (GREP_NAMES.has(toolName)) {
		toolType = "grep";
		const pattern = textValue(input.pattern);
		const path = textValue(input.path);
		summary = `Grep search: ${pattern}`;
		body = codeFence(
			`Pattern: ${pattern}\nPath: ${path}\nMatches:\n${isError ? `Error: ${output}` : output}`,
		);
	} else if (WRITE_NAMES.has(toolName)) {
		toolType = "write";
		summary = `Edit file: ${filePathFromInput(input)}`;
		const content = textValue(input.content);
		// Render the new file as an all-additions diff so the LOC enricher counts
		// every line (the file content is preserved even on rejection/abort, where
		// `output` is just the error). Falls back to the raw output when there's
		// no content to show.
		const diff = diffFromWriteContent(content);
		body = diff
			? `${codeFence(diff, "diff")}\n\n${isError ? `Error: ${output}` : output}`
			: isError
				? `Error: ${output}`
				: output;
	} else if (EDIT_NAMES.has(toolName)) {
		toolType = "write";
		summary = `Edit file: ${filePathFromInput(input)}`;
		const diff = diffFromEditInput(input);
		body = diff
			? `${codeFence(diff, "diff")}\n\n${isError ? `Error: ${output}` : output}`
			: isError
				? `Error: ${output}`
				: output.includes("<<<") ||
						output.includes("---") ||
						output.includes("+++")
					? codeFence(output, "diff")
					: codeFence(output);
	} else if (TASK_NAMES.has(toolName)) {
		toolType = "task";
		const desc = textValue(input.description);
		const prompt = textValue(input.prompt);
		summary = `Spawn subagent: ${desc || name}`;
		body = `**Prompt**:\n${prompt}\n\n**Result**:\n${isError ? `Error: ${output}` : output}`;
	}

	const editStatus =
		toolType === "write"
			? ` data-edit-status="${aborted ? "aborted" : isError ? "rejected" : "accepted"}"`
			: "";
	return `<tool-use data-tool-type="${toolType}" data-tool-name="${toolName}"${editStatus}>\n<details>\n<summary>${summary}</summary>\n\n${body}\n</details>\n</tool-use>\n`;
}
