import { getBackupStatus, restoreTool, type Tool } from "@/lib/configure.js";

// Launch-name aliases that `codev restore <name>` accepts. The first three
// match the agent launchers (`codev claude`, `codev codex`, `codev opencode`)
// — `claude-code` is an internal Tool name and isn't exposed here. `continue`
// has no launcher (the user opens VS Code or a JetBrains IDE directly), and
// the underlying ~/.continue/config.yaml is shared across both editors —
// hence one editor-neutral alias rather than `vscode` + `jetbrains` for the
// same backup file.
export const RESTORE_AGENTS = [
	"claude",
	"codex",
	"opencode",
	"continue",
] as const;
export type RestoreAgent = (typeof RESTORE_AGENTS)[number];

const TOOL_FOR_AGENT: Record<RestoreAgent, Tool> = {
	claude: "claude-code",
	codex: "codex",
	opencode: "opencode",
	// Either editor Tool routes to the same `continue-config` BackupKind
	// — picking `vscode-continue` is canonical, not editor-specific.
	continue: "vscode-continue",
};

export function toolForRestoreAgent(agent: RestoreAgent): Tool {
	return TOOL_FOR_AGENT[agent];
}

export function runRestore(tool: Tool): number {
	const result = restoreTool(tool);
	if (result.status === "no-backup") {
		console.error(`No backup found at ${result.backupPath}.`);
		return 1;
	}
	console.log(`Restored ${result.sourcePath} from ${result.backupPath}.`);
	return 0;
}

// Bare `codev restore` — sweep every tool that has a *.backup on disk and
// restore each. Tools without a backup are skipped silently (not an error,
// since "nothing to restore" is the normal state for unconfigured tools).
// Returns 0 unless at least one tool failed or every tool was skipped.
export function runRestoreAll(): number {
	const tools: Tool[] = [
		"claude-code",
		"codex",
		"opencode",
		"vscode-claude-code",
		"jetbrains-claude-code",
		"vscode-continue",
		"jetbrains-continue",
	];
	let restored = 0;
	let failed = 0;

	for (const tool of tools) {
		const [status] = getBackupStatus(tool);
		if (!status?.hasBackup) continue;
		try {
			const result = restoreTool(tool);
			if (result.status === "restored") {
				console.log(`Restored ${result.sourcePath} from ${result.backupPath}.`);
				restored++;
			} else {
				// hasBackup was true a moment ago; if restoreTool now reports
				// no-backup the file vanished between the check and the rename.
				console.error(
					`Backup for ${tool} disappeared during restore (${result.backupPath}).`,
				);
				failed++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`Failed to restore ${tool}: ${msg}`);
			failed++;
		}
	}

	if (restored === 0 && failed === 0) {
		console.error("No backups found. Nothing to restore.");
		return 1;
	}
	return failed > 0 ? 1 : 0;
}
