import { Box, Text } from "ink";
import { YesNo } from "@/components/YesNo.js";
import { getBackupStatus, type Tool } from "@/lib/configure.js";

interface ConfirmProps {
	tools: Tool[];
	onConfirm: (proceed: boolean) => void;
	readOnly?: boolean;
}

const TOOL_LABEL: Record<Tool, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	"vscode-continue": "VSCode (Continue)",
};

const RESTORE_CMD: Record<Tool, string> = {
	"claude-code": "codev restore claude",
	codex: "codev restore codex",
	opencode: "codev restore opencode",
	"vscode-continue": "codev restore vscode",
};

export function Confirm({ tools, onConfirm, readOnly = false }: ConfirmProps) {
	return (
		<Box flexDirection="column">
			{tools.map((tool) => {
				const [status] = getBackupStatus(tool);
				if (!status) return null;
				return (
					<Box key={tool} flexDirection="column">
						<Text>{`• ${TOOL_LABEL[tool]}`}</Text>
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
							<Text color="cyan">{RESTORE_CMD[tool]}</Text>
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
