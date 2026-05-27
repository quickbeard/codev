import { type TaskItem, TaskList } from "@/components/TaskList.js";
import type { Tool } from "@/lib/configure.js";
import {
	CLAUDE_CODE_INTELLIJ_PLUGIN_ID,
	CONTINUE_INTELLIJ_PLUGIN_ID,
	installClaudeCodePlugin,
	installContinuePlugin,
} from "@/lib/jetbrains.js";
import { installAndVerify, isNpmTool, PKG } from "@/lib/npm.js";
import {
	CLAUDE_CODE_EXTENSION_ID,
	CONTINUE_EXTENSION_ID,
	installClaudeCodeExtension,
	installContinueExtension,
} from "@/lib/vscode.js";

// Manual-install reassurances appended to the row warning when the extension
// or plugin auto-install soft-fails. Deliberately generic — there are
// several paths the user could take (in-IDE extensions UI, IDE CLI,
// downloading from the marketplace page, etc.) and naming one risks reading
// like "this is what CoDev was trying to do." We just confirm a manual
// fallback exists.
const VSCODE_CONTINUE_HINT =
	"You can install the Continue extension yourself later.";
const JETBRAINS_CONTINUE_HINT =
	"You can install the Continue plugin yourself later.";
const VSCODE_CLAUDE_CODE_HINT =
	"You can install the Claude Code extension yourself later.";
const JETBRAINS_CLAUDE_CODE_HINT =
	"You can install the Claude Code plugin yourself later.";

interface InstallProps {
	tools: Tool[];
	// Forwarded straight from TaskList: keys of tools whose install did not
	// hard-fail (includes both ✓ done and ▲ warned rows). InstallApp uses
	// the list to either park at install-failed (empty) or advance to
	// Configure with just the survivors.
	onDone: (succeededKeys: string[]) => void;
}

export function Install({ tools, onDone }: InstallProps) {
	const tasks: TaskItem[] = tools.map((tool) => {
		if (isNpmTool(tool)) {
			return {
				key: tool,
				label: PKG[tool],
				run: () => installAndVerify(tool),
			};
		}
		if (tool === "vscode-claude-code") {
			return {
				key: tool,
				label: `${CLAUDE_CODE_EXTENSION_ID} (VS Code)`,
				run: async () => {
					const r = await installClaudeCodeExtension();
					if (r === null) return null;
					return { warning: `${r.warning}. ${VSCODE_CLAUDE_CODE_HINT}` };
				},
			};
		}
		if (tool === "jetbrains-claude-code") {
			return {
				key: tool,
				label: `${CLAUDE_CODE_INTELLIJ_PLUGIN_ID} (JetBrains)`,
				run: async () => {
					const r = await installClaudeCodePlugin();
					if (r === null) return null;
					return { warning: `${r.warning}. ${JETBRAINS_CLAUDE_CODE_HINT}` };
				},
			};
		}
		if (tool === "vscode-continue") {
			return {
				key: tool,
				label: `${CONTINUE_EXTENSION_ID} (VS Code)`,
				run: async () => {
					const r = await installContinueExtension();
					if (r === null) return null;
					return { warning: `${r.warning}. ${VSCODE_CONTINUE_HINT}` };
				},
			};
		}
		// jetbrains-continue
		return {
			key: tool,
			label: `${CONTINUE_INTELLIJ_PLUGIN_ID} (JetBrains)`,
			run: async () => {
				const r = await installContinuePlugin();
				if (r === null) return null;
				return { warning: `${r.warning}. ${JETBRAINS_CONTINUE_HINT}` };
			},
		};
	});
	return (
		<TaskList
			tasks={tasks}
			verb={{ infinitive: "install", present: "Installing", past: "Installed" }}
			onDone={onDone}
		/>
	);
}
