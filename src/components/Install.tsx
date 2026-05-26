import { type TaskItem, TaskList } from "@/components/TaskList.js";
import type { Tool } from "@/lib/configure.js";
import {
	CONTINUE_INTELLIJ_PLUGIN_ID,
	installContinuePlugin,
} from "@/lib/jetbrains.js";
import { installAndVerify, isNpmTool, PKG } from "@/lib/npm.js";
import {
	CONTINUE_EXTENSION_ID,
	installContinueExtension,
} from "@/lib/vscode.js";

// Manual-install reassurances appended to the row warning when the Continue
// extension/plugin auto-install soft-fails. Deliberately generic — there are
// several paths the user could take (in-IDE plugins UI, IDE CLI, downloading
// from the marketplace page, etc.) and naming one risks reading like "this is
// what CoDev was trying to do." We just confirm a manual fallback exists.
const VSCODE_HINT = "You can install the Continue extension yourself later.";
const JETBRAINS_HINT = "You can install the Continue plugin yourself later.";

interface InstallProps {
	tools: Tool[];
	onDone: (success: boolean) => void;
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
		if (tool === "vscode-continue") {
			return {
				key: tool,
				label: `${CONTINUE_EXTENSION_ID} (VS Code)`,
				run: async () => {
					const r = await installContinueExtension();
					if (r === null) return null;
					return { warning: `${r.warning}. ${VSCODE_HINT}` };
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
				return { warning: `${r.warning}. ${JETBRAINS_HINT}` };
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
