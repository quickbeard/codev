import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { YesNo } from "@/components/YesNo.js";
import { type BackupKind, kindForTool, type Tool } from "@/lib/configure.js";

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
	"claude-settings": "codev restore claude",
	"claude-json": "codev restore claude",
	"claude-credentials": "codev restore claude",
	"codex-config": "codev restore codex",
	"opencode-config": "codev restore opencode",
	"codev-code-config": "codev restore codev-code",
	"continue-config": "codev restore continue",
};

// Render the restore-command list with cyan emphasis on each command,
// matching `formatToolList`'s Oxford-comma / "and" join rules:
//   1 →  X
//   2 →  X and Y
//   3+ → X, Y, and Z
function renderCommandList(cmds: string[]): ReactNode {
	if (cmds.length === 0) return null;
	const nodes: ReactNode[] = [];
	// Cmds are deduped by BackupKind upstream, so each command string is
	// unique within `cmds` and safe to use as a React key. Separators key
	// off the trailing command to inherit that uniqueness.
	cmds.forEach((cmd, i) => {
		if (i > 0) {
			const isLast = i === cmds.length - 1;
			let sep: string;
			if (cmds.length === 2) sep = " and ";
			else if (isLast) sep = ", and ";
			else sep = ", ";
			nodes.push(<Text key={`sep-${cmd}`}>{sep}</Text>);
		}
		nodes.push(
			<Text key={`cmd-${cmd}`} color="cyan">
				{cmd}
			</Text>,
		);
	});
	return nodes;
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
					{"To revert to your pre-CoDev state, run "}
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
			{"Heads up — CoDev will change your settings."}
		</Text>
	);
}
