import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { YesNo } from "@/components/YesNo.js";
import { type BackupKind, kindForTool, type Tool } from "@/lib/configure.js";
import { formatListParts, t } from "@/lib/i18n.js";

interface ConfirmProps {
	tools: Tool[];
	onConfirm: (proceed: boolean) => void;
	readOnly?: boolean;
}

// One restore command per BackupKind. `kindForTool` returns `claude-settings`
// for every Claude variant, so the `claude-json` / `claude-credentials`
// entries are only present for Record<BackupKind, …> type completeness —
// they're never reached at runtime. Continue's two editor variants share
// `continue-config`, so the alias is editor-neutral.
const KIND_RESTORE_CMD: Record<BackupKind, string> = {
	"claude-settings": "codevhub restore claude",
	"claude-json": "codevhub restore claude",
	"claude-credentials": "codevhub restore claude",
	"codex-config": "codevhub restore codex",
	"opencode-config": "codevhub restore opencode",
	"codev-code-config": "codevhub restore codev",
	"continue-config": "codevhub restore continue",
};

// Render the restore-command list with cyan emphasis on each command.
//
// The separators come from `formatListParts` (Intl.ListFormat) rather than the
// hand-written " and " / ", and " / ", " ladder this used to carry: those rules
// are English's, and a locale that joins differently had no way to express it.
// Splitting into parts is what lets the commands stay cyan while the separators
// between them render plain.
function renderCommandList(cmds: string[]): ReactNode {
	if (cmds.length === 0) return null;
	// Cmds are deduped by BackupKind upstream, so each command string is unique
	// within `cmds`; part indices key the separators, which are not.
	return formatListParts(cmds).map((part, i) =>
		part.type === "element" ? (
			<Text key={`cmd-${part.value}`} color="cyan">
				{part.value}
			</Text>
		) : (
			<Text key={`sep-${i.toString()}`}>{part.value}</Text>
		),
	);
}

export function Confirm({ tools, onConfirm, readOnly = false }: ConfirmProps) {
	// Dedupe by BackupKind so a `vscode-continue` + `jetbrains-continue`
	// selection emits one restore command, not two; same for Claude variants.
	const seen = new Set<BackupKind>();
	const cmds: string[] = [];
	for (const tool of tools) {
		const kind = kindForTool(tool);
		if (seen.has(kind)) continue;
		seen.add(kind);
		cmds.push(KIND_RESTORE_CMD[kind]);
	}

	return (
		<Box flexDirection="column">
			{cmds.length > 0 && (
				<Text>
					{t("confirm.revert_prefix")}
					{renderCommandList(cmds)}
					{"."}
				</Text>
			)}
			{!readOnly && (
				<Box marginTop={1}>
					<YesNo defaultAnswer="no" onAnswer={onConfirm} />
				</Box>
			)}
		</Box>
	);
}

export function confirmTitle() {
	return (
		<Text bold color="yellow">
			{t("confirm.title")}
		</Text>
	);
}
