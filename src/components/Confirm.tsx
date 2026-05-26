import { Box, Text } from "ink";
import { YesNo } from "@/components/YesNo.js";
import {
	type BackupKind,
	getBackupStatus,
	kindForTool,
	type Tool,
} from "@/lib/configure.js";

interface ConfirmProps {
	tools: Tool[];
	onConfirm: (proceed: boolean) => void;
	readOnly?: boolean;
}

// Both Continue editor tools share ~/.continue/config.yaml, so we dedupe
// rows by BackupKind. That keeps the Confirm view from showing two
// identical Path/Backup lines and from suggesting two restore commands
// (which would race each other — the first rolls the shared file back,
// the second sees no backup and errors).
const KIND_LABEL: Record<BackupKind, string> = {
	"claude-settings": "Claude Code",
	"codex-config": "Codex",
	"opencode-config": "OpenCode",
	"continue-config": "Continue",
};

// `continue-config` is shared across VS Code + JetBrains, so the restore
// alias is editor-neutral (`codev restore continue`) rather than naming
// either editor.
const KIND_RESTORE_CMD: Record<BackupKind, string> = {
	"claude-settings": "codev restore claude",
	"codex-config": "codev restore codex",
	"opencode-config": "codev restore opencode",
	"continue-config": "codev restore continue",
};

export function Confirm({ tools, onConfirm, readOnly = false }: ConfirmProps) {
	const seen = new Set<BackupKind>();
	return (
		<Box flexDirection="column">
			{tools.map((tool) => {
				const kind = kindForTool(tool);
				if (seen.has(kind)) return null;
				seen.add(kind);
				const [status] = getBackupStatus(tool);
				if (!status) return null;
				return (
					<Box key={tool} flexDirection="column">
						<Text>{`• ${KIND_LABEL[kind]}`}</Text>
						<Text>{`  Path: ${status.sourcePath}`}</Text>
						{status.hasBackup ? (
							<Text>
								{`  Backup: ${status.backupPath} already exists and will not be overwritten.`}
							</Text>
						) : status.hasSource ? (
							<Text>
								{`  Backup: ${status.sourcePath} → ${status.backupPath}`}
							</Text>
						) : null}
						<Text>
							{"  You can revert to your previous settings by running "}
							<Text color="cyan">{KIND_RESTORE_CMD[kind]}</Text>
							{". You might need to restart your current session."}
						</Text>
					</Box>
				);
			})}
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
			{
				"Heads up — CoDev will back up your existing settings and replace them with new settings."
			}
		</Text>
	);
}
