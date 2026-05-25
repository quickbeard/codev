import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Tool } from "@/lib/configure.js";

export type ContinueEditor = Extract<
	Tool,
	"vscode-continue" | "jetbrains-continue"
>;

const EDITORS: { label: string; value: ContinueEditor }[] = [
	{ label: "VS Code", value: "vscode-continue" },
	{
		label: "JetBrains (PyCharm / IntelliJ IDEA / GoLand)",
		value: "jetbrains-continue",
	},
];

interface ContinueEditorSelectProps {
	onConfirm: (editors: ContinueEditor[]) => void;
	readOnly?: boolean;
}

export function ContinueEditorSelect({
	onConfirm,
	readOnly = false,
}: ContinueEditorSelectProps) {
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<ContinueEditor>>(new Set());

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

export function continueEditorSelectTitle(readOnly = false) {
	return (
		<Text bold>
			{"Select the editor(s) you use Continue with "}
			{!readOnly && (
				<Text dimColor>(↑/↓ to move, Space to select, Enter to confirm)</Text>
			)}
		</Text>
	);
}
