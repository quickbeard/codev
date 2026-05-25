import { useRef } from "react";
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

// Per-task warning surfaced from the install step. `vscode-continue` and
// `jetbrains-continue` are soft-fail: either the editor CLI wasn't on PATH
// or the install ran and returned non-zero. We don't want a transient
// marketplace/network failure to abort the install flow before the YAML
// config gets written, so the task completes (yellow ▲) and the warning
// rides forward to Configure, which renders a more detailed manual-install
// hint with the exact CLI command. `message` is the short cause string —
// the install row gets a longer form with a "you can install it manually"
// reassurance tacked on (see VSCODE_HINT / JETBRAINS_HINT below).
export interface InstallWarning {
	tool: Tool;
	message: string;
}

// Manual-install reassurances rendered on the install row right after the
// cause message. Deliberately generic — there are several paths the user
// could take (in-IDE plugins UI, IDE CLI, downloading from the marketplace
// page, etc.) and naming one risks reading like "this is what CoDev was
// trying to do." We just confirm a manual fallback exists.
//
// Exported because `Configure.tsx`'s yellow follow-up hint reuses the same
// sentence — one source of truth so reword-here-but-not-there can't happen.
export const VSCODE_HINT =
	"You can install the Continue extension yourself later.";
export const JETBRAINS_HINT =
	"You can install the Continue plugin yourself later.";

interface InstallProps {
	tools: Tool[];
	onDone: (success: boolean, warnings: InstallWarning[]) => void;
}

export function Install({ tools, onDone }: InstallProps) {
	// Collected via the task closures and read in onDone's final handler.
	// useRef rather than state — these warnings don't drive rendering.
	const warningsRef = useRef<InstallWarning[]>([]);

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
					// Configure consumes the short cause string; the install row
					// shows cause + reassurance so the user isn't left wondering
					// whether they need to do anything next.
					warningsRef.current.push({ tool, message: r.warning });
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
				warningsRef.current.push({ tool, message: r.warning });
				return { warning: `${r.warning}. ${JETBRAINS_HINT}` };
			},
		};
	});
	return (
		<TaskList
			tasks={tasks}
			verb={{ infinitive: "install", present: "Installing", past: "Installed" }}
			onDone={(success) => onDone(success, warningsRef.current)}
		/>
	);
}
