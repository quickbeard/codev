import { Box, Text, useInput } from "ink";
import { useState } from "react";

// Editor-agnostic identifier returned from the sub-select. The InstallApp
// handler maps these to extension-specific Tool values (e.g.
// `vscode-claude-code` / `jetbrains-continue`) based on which sentinel(s)
// the user picked in ToolSelect. Keeping the component itself ignorant of
// the extensions means the merged step works whether the user picked
// Claude Code (extension), Continue (extension), or both.
export type Editor = "vscode" | "jetbrains";

const EDITORS: { label: string; value: Editor }[] = [
	{ label: "VS Code", value: "vscode" },
	{
		label: "JetBrains (PyCharm / IntelliJ IDEA / GoLand)",
		value: "jetbrains",
	},
];

interface EditorSelectProps {
	onConfirm: (editors: Editor[]) => void;
	readOnly?: boolean;
}

export function EditorSelect({
	onConfirm,
	readOnly = false,
}: EditorSelectProps) {
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<Editor>>(new Set());

	useInput(
		(input, key) => {
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(EDITORS.length - 1, c + 1));
			} else if (input === " ") {
				setSelected((prev) => {
					const next = new Set(prev);
					const ed = EDITORS[cursor];
					if (!ed) return next;
					if (next.has(ed.value)) {
						next.delete(ed.value);
					} else {
						next.add(ed.value);
					}
					return next;
				});
			} else if (key.return) {
				if (selected.size === 0) return;
				onConfirm([...selected]);
			}
		},
		{ isActive: !readOnly },
	);

	return (
		<Box flexDirection="column">
			{EDITORS.map((ed, i) => {
				const isSelected = selected.has(ed.value);
				const isCursor = !readOnly && cursor === i;
				return (
					<Box key={ed.value}>
						<Text color={isSelected ? "green" : undefined}>
							{isSelected ? "■" : "□"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor}>
							{ed.label}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function editorSelectTitle(readOnly = false) {
	return (
		<Text bold>
			{"Select the editor(s) to install extensions in "}
			{!readOnly && (
				<Text dimColor>(↑/↓ to move, Space to select, Enter to confirm)</Text>
			)}
		</Text>
	);
}
