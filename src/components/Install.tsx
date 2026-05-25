import { TaskList } from "@/components/TaskList.js";
import type { Tool } from "@/lib/configure.js";
import { installAndVerify, isNpmTool, PKG } from "@/lib/npm.js";
import {
	CONTINUE_EXTENSION_ID,
	installContinueExtension,
} from "@/lib/vscode.js";

interface InstallProps {
	tools: Tool[];
	onDone: (success: boolean) => void;
}

export function Install({ tools, onDone }: InstallProps) {
	const tasks = tools.map((tool) => {
		if (isNpmTool(tool)) {
			return {
				key: tool,
				label: PKG[tool],
				run: () => installAndVerify(tool),
			};
		}
		// vscode-continue: best-effort `code --install-extension`. The task shows
		// as `Installing continue.continue...` then `Installed continue.continue`.
		// ENOENT (no `code` on PATH) resolves null silently — the YAML config is
		// still written, and the resume message hints the user to install the
		// extension manually.
		return {
			key: tool,
			label: CONTINUE_EXTENSION_ID,
			run: installContinueExtension,
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
