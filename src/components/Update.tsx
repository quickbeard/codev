import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { type TaskItem, TaskList } from "@/components/TaskList.js";
import { detectConfiguredTools } from "@/lib/configure.js";
import {
	CONTINUE_INTELLIJ_PLUGIN_ID,
	installContinuePlugin,
	isAnyJetBrainsCliAvailable,
} from "@/lib/jetbrains.js";
import {
	detectInstalledViaNpm,
	installAndVerify,
	type NpmTool,
	PKG,
} from "@/lib/npm.js";
import {
	CONTINUE_EXTENSION_ID,
	installContinueExtension,
	isCodeCliAvailable,
} from "@/lib/vscode.js";

const NPM_TOOLS: NpmTool[] = ["claude-code", "codex", "opencode"];

// Targets for the Continue update branch. We probe each editor's launcher
// at update time and only schedule the corresponding task if it's on PATH
// — otherwise users without that editor would see a spurious
// `▲ Warning: <X> launcher not found...` row from a tool they never
// installed.
type ContinueTarget = "vscode" | "jetbrains";

type Phase =
	| { kind: "detecting" }
	| { kind: "nothing" }
	| {
			kind: "updating";
			npmTools: NpmTool[];
			continueTargets: ContinueTarget[];
	  };

interface UpdateProps {
	onDone: (success: boolean) => void;
}

export function Update({ onDone }: UpdateProps) {
	const [phase, setPhase] = useState<Phase>({ kind: "detecting" });
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		(async () => {
			// npm side: detect by walking the global node_modules tree, same as
			// before. Continue side: trust the YAML marker as the "we installed
			// this" signal — `detectConfiguredTools` returns `vscode-continue`
			// canonically when ~/.continue/config.yaml carries CoDev's marker.
			const [npmFlags, hasContinueConfig] = await Promise.all([
				Promise.all(NPM_TOOLS.map((t) => detectInstalledViaNpm(t))),
				Promise.resolve(detectConfiguredTools().includes("vscode-continue")),
			]);
			const detectedNpm = NPM_TOOLS.filter((_, i) => npmFlags[i]);

			const continueTargets: ContinueTarget[] = [];
			if (hasContinueConfig) {
				const [vscode, jetbrains] = await Promise.all([
					isCodeCliAvailable(),
					isAnyJetBrainsCliAvailable(),
				]);
				if (vscode) continueTargets.push("vscode");
				if (jetbrains) continueTargets.push("jetbrains");
			}

			if (detectedNpm.length === 0 && continueTargets.length === 0) {
				setPhase({ kind: "nothing" });
				onDone(true);
				return;
			}
			setPhase({ kind: "updating", npmTools: detectedNpm, continueTargets });
		})();
	}, [onDone]);

	if (phase.kind === "detecting") {
		return (
			<Box>
				<Box marginRight={1}>
					<Text color="cyan">
						<Spinner />
					</Text>
				</Box>
				<Text>Checking installed agents...</Text>
			</Box>
		);
	}

	if (phase.kind === "nothing") {
		return <Text>Nothing to update.</Text>;
	}

	const tasks: TaskItem[] = [
		...phase.npmTools.map((tool) => ({
			key: tool,
			label: PKG[tool],
			run: () => installAndVerify(tool),
		})),
		...phase.continueTargets.map((target): TaskItem => {
			if (target === "vscode") {
				return {
					key: "vscode-continue",
					label: `${CONTINUE_EXTENSION_ID} (VS Code)`,
					run: installContinueExtension,
				};
			}
			return {
				key: "jetbrains-continue",
				label: `${CONTINUE_INTELLIJ_PLUGIN_ID} (JetBrains)`,
				run: installContinuePlugin,
			};
		}),
	];
	return (
		<TaskList
			tasks={tasks}
			verb={{ infinitive: "update", present: "Updating", past: "Updated" }}
			onDone={onDone}
		/>
	);
}
