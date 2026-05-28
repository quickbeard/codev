import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { type TaskItem, TaskList } from "@/components/TaskList.js";
import { detectConfiguredTools } from "@/lib/configure.js";
import {
	CLAUDE_CODE_INTELLIJ_PLUGIN_ID,
	CONTINUE_INTELLIJ_PLUGIN_ID,
	installClaudeCodePlugin,
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
	CLAUDE_CODE_EXTENSION_ID,
	CONTINUE_EXTENSION_ID,
	installClaudeCodeExtension,
	installContinueExtension,
	isCodeCliAvailable,
} from "@/lib/vscode.js";

const NPM_TOOLS: NpmTool[] = ["claude-code", "codex", "opencode"];

// Targets for the Continue update branch. We probe each editor's launcher
// at update time and only schedule the corresponding task if it's on PATH
// — otherwise users without that editor would see a spurious
// `▲ Warning: <X> launcher not found...` row from a tool they never
// installed.
type ExtensionTarget = "vscode" | "jetbrains";

type Phase =
	| { kind: "detecting" }
	| { kind: "nothing" }
	| {
			kind: "updating";
			npmTools: NpmTool[];
			// NB: marker ambiguity — `~/.claude/settings.json` is written when
			// the user picks the CLI, the extension, or both, so the
			// `claude-code` marker on its own can't distinguish those cases.
			// Mirror-Continue behavior: if the marker is present AND the IDE
			// launcher is on PATH, schedule the extension/plugin install. A
			// CLI-only user with `code` on PATH will see the extension
			// installed at `codev update` time — idempotent and easy to
			// uninstall, but slightly more aggressive than Continue's update
			// (where the YAML marker is a clean "user wanted Continue" signal).
			claudeCodeExtTargets: ExtensionTarget[];
			continueTargets: ExtensionTarget[];
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
			// before. Extension side: trust the config-file markers as the "we
			// installed this" signal — `detectConfiguredTools` returns
			// `claude-code` when ~/.claude/settings.json carries CoDev's
			// marker and `vscode-continue` (canonical for both Continue
			// variants) when ~/.continue/config.yaml does.
			const detected = detectConfiguredTools();
			const hasClaudeCodeMarker = detected.includes("claude-code");
			const hasContinueMarker = detected.includes("vscode-continue");

			const [npmFlags, vscodeAvailable, jetbrainsAvailable] = await Promise.all(
				[
					Promise.all(NPM_TOOLS.map((t) => detectInstalledViaNpm(t))),
					hasClaudeCodeMarker || hasContinueMarker
						? isCodeCliAvailable()
						: Promise.resolve(false),
					hasClaudeCodeMarker || hasContinueMarker
						? isAnyJetBrainsCliAvailable()
						: Promise.resolve(false),
				],
			);
			const detectedNpm = NPM_TOOLS.filter((_, i) => npmFlags[i]);

			const claudeCodeExtTargets: ExtensionTarget[] = [];
			if (hasClaudeCodeMarker) {
				if (vscodeAvailable) claudeCodeExtTargets.push("vscode");
				if (jetbrainsAvailable) claudeCodeExtTargets.push("jetbrains");
			}

			const continueTargets: ExtensionTarget[] = [];
			if (hasContinueMarker) {
				if (vscodeAvailable) continueTargets.push("vscode");
				if (jetbrainsAvailable) continueTargets.push("jetbrains");
			}

			if (
				detectedNpm.length === 0 &&
				claudeCodeExtTargets.length === 0 &&
				continueTargets.length === 0
			) {
				setPhase({ kind: "nothing" });
				onDone(true);
				return;
			}
			setPhase({
				kind: "updating",
				npmTools: detectedNpm,
				claudeCodeExtTargets,
				continueTargets,
			});
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
		...phase.claudeCodeExtTargets.map((target): TaskItem => {
			if (target === "vscode") {
				return {
					key: "vscode-claude-code",
					label: `${CLAUDE_CODE_EXTENSION_ID} (VS Code)`,
					run: installClaudeCodeExtension,
				};
			}
			return {
				key: "jetbrains-claude-code",
				label: `${CLAUDE_CODE_INTELLIJ_PLUGIN_ID} (JetBrains)`,
				run: installClaudeCodePlugin,
			};
		}),
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
			// Update keeps its all-or-nothing contract: UpdateApp aborts on
			// any failure, no partial-success advance. Adapt TaskList's
			// survivor-key list to a boolean here so UpdateApp's onDone shape
			// stays unchanged.
			onDone={(keys) => onDone(keys.length === tasks.length)}
		/>
	);
}
