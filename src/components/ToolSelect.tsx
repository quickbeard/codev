import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Tool } from "@/lib/configure.js";
import { t } from "@/lib/i18n.js";

// Sentinel values emitted when the user picks an editor-extension row.
// InstallApp expands them via the merged EditorSelect sub-step into the
// editor-specific Tool values (e.g. `vscode-claude-code` /
// `jetbrains-continue`). Two separate sentinels (one per extension) let
// downstream code know which extension(s) the editor choice applies to.
export const CLAUDE_CODE_EXT_SENTINEL = "claude-code-ext" as const;
export const CONTINUE_SENTINEL = "continue" as const;
export type ToolSelectSentinel =
	| typeof CLAUDE_CODE_EXT_SENTINEL
	| typeof CONTINUE_SENTINEL;
export type ToolSelectValue = Tool | ToolSelectSentinel;

const TOOLS: {
	label: string;
	value: ToolSelectValue;
	locked?: boolean;
	hidden?: boolean;
}[] = [
	// CoDev Code is the flagship agent — always installed and configured, so its
	// row is shown pre-checked and can't be toggled off. Kept at index 0 so the
	// optional agents keep their positions.
	{ label: "CoDev Code", value: "codev-code", locked: true },
	{ label: "Claude Code", value: "claude-code" },
	// Codex and OpenCode are temporarily withheld from the selection UI. All the
	// underlying configure/install/update logic still handles them end-to-end —
	// they're only hidden from users until we're ready to surface them. Flip
	// `hidden` off (or delete it) to bring the rows back.
	{ label: "Codex", value: "codex", hidden: true },
	{ label: "OpenCode", value: "opencode", hidden: true },
	{ label: "Claude Code (extension)", value: CLAUDE_CODE_EXT_SENTINEL },
	{ label: "Continue (extension)", value: CONTINUE_SENTINEL },
];

// Rows actually rendered and navigable. Hidden tools are dropped from the UI
// only; everything downstream (Configure, restore, update) is untouched.
const VISIBLE_TOOLS = TOOLS.filter((tool) => !tool.hidden);

// Locked tools are emitted on every confirm regardless of the mutable
// selection, and always lead the emitted list.
const LOCKED_VALUES: ToolSelectValue[] = VISIBLE_TOOLS.filter(
	(tool) => tool.locked,
).map((tool) => tool.value);

interface ToolSelectProps {
	onConfirm: (tools: ToolSelectValue[]) => void;
	readOnly?: boolean;
	mode?: "install" | "config";
}

export function ToolSelect({
	onConfirm,
	readOnly = false,
	mode = "install",
}: ToolSelectProps) {
	const [cursor, setCursor] = useState(0);
	const [selected, setSelected] = useState<Set<ToolSelectValue>>(new Set());

	useInput(
		(input, key) => {
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(VISIBLE_TOOLS.length - 1, c + 1));
			} else if (input === " ") {
				const tool = VISIBLE_TOOLS[cursor];
				// Locked rows (CoDev Code) are always included and can't be toggled.
				if (!tool || tool.locked) return;
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(tool.value)) {
						next.delete(tool.value);
					} else {
						next.add(tool.value);
					}
					return next;
				});
			} else if (key.return) {
				// The locked defaults guarantee a non-empty selection, so Enter
				// always proceeds — even with no optional agents picked.
				onConfirm([...LOCKED_VALUES, ...selected]);
			}
		},
		{ isActive: !readOnly },
	);

	// The rows themselves are brand names and stay untranslated in every locale;
	// only this suffix and the title below are message keys.
	const lockedSuffix = ` ${t(
		mode === "config"
			? "tool_select.locked.config"
			: "tool_select.locked.install",
	)}`;

	return (
		<Box flexDirection="column">
			{VISIBLE_TOOLS.map((tool, i) => {
				const isSelected = tool.locked || selected.has(tool.value);
				const isCursor = !readOnly && cursor === i;
				return (
					<Box key={tool.value}>
						<Text color={isSelected ? "green" : undefined}>
							{isSelected ? "■" : "□"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor}>
							{tool.label}
						</Text>
						{tool.locked && <Text dimColor>{lockedSuffix}</Text>}
					</Box>
				);
			})}
		</Box>
	);
}

export function toolSelectTitle(
	readOnly = false,
	mode: "install" | "config" = "install",
) {
	// One complete sentence per mode rather than an English verb dropped into a
	// shared frame — the frame does not survive translation.
	const title = t(
		mode === "install"
			? "tool_select.title.install"
			: "tool_select.title.config",
	);
	return (
		<Text bold>
			{`${title} `}
			{!readOnly && (
				<Text dimColor>{t("common.hint.move_select_confirm")}</Text>
			)}
		</Text>
	);
}
