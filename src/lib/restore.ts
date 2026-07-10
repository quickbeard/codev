import { type RestoreResult, restoreTool, type Tool } from "@/lib/configure.js";

// Launch-name aliases that `codevhub restore <name>` accepts. The first three
// match the agent launchers (`codevhub claude`, `codevhub codex`,
// `codevhub opencode`) — `claude-code` is an internal Tool name and isn't
// exposed here. `continue`
// has no launcher (the user opens VS Code or a JetBrains IDE directly), and
// the underlying ~/.continue/config.yaml is shared across both editors —
// hence one editor-neutral alias rather than `vscode` + `jetbrains` for the
// same backup file.
export const RESTORE_AGENTS = [
	"claude",
	"codex",
	"opencode",
	"codev",
	"continue",
] as const;
export type RestoreAgent = (typeof RESTORE_AGENTS)[number];

const TOOL_FOR_AGENT: Record<RestoreAgent, Tool> = {
	claude: "claude-code",
	codex: "codex",
	opencode: "opencode",
	codev: "codev-code",
	// Either editor Tool routes to the same `continue-config` BackupKind
	// — picking `vscode-continue` is canonical, not editor-specific.
	continue: "vscode-continue",
};

export function toolForRestoreAgent(agent: RestoreAgent): Tool {
	return TOOL_FOR_AGENT[agent];
}

function reportRestoreResult(result: RestoreResult): void {
	switch (result.status) {
		case "restored":
			console.log(`Restored ${result.sourcePath} from ${result.backupPath}.`);
			return;
		case "kept-live":
			console.log(
				`No backup at ${result.backupPath}; left ${result.sourcePath} in place.`,
			);
			return;
		case "noop":
			console.log(
				`Nothing to restore for ${result.sourcePath}; already at pre-CoDev state.`,
			);
			return;
	}
}

export function runRestore(tool: Tool): number {
	const results = restoreTool(tool);
	for (const result of results) {
		reportRestoreResult(result);
	}
	return 0;
}

// One Tool per BackupKind. The extension variants (`vscode-claude-code`,
// `jetbrains-claude-code`, `jetbrains-continue`) share their config file with
// the canonical entry, so iterating them too would redundantly re-report the
// same file (the second visit sees no backup left and reports keeping the file
// the first visit just restored).
const SWEEP_TOOLS: Tool[] = [
	"claude-code",
	"codex",
	"opencode",
	"codev-code",
	"vscode-continue",
];

// Bare `codevhub restore` — process every tool. Each result ends in one of
// three states (restored / kept-live / noop); only `restored` actually reverts
// a file. Counters aggregate across all results from all sweep tools
// (claude-code contributes three results, the others one). Exit 1 if nothing
// was restored (every result was kept-live or noop) or any tool threw;
// otherwise 0.
export function runRestoreAll(): number {
	let acted = 0;
	let failed = 0;
	let noop = 0;

	for (const tool of SWEEP_TOOLS) {
		try {
			const results = restoreTool(tool);
			for (const result of results) {
				reportRestoreResult(result);
				// Only a genuine restore counts as action; kept-live left the file
				// untouched, so it falls in with noop for the "nothing restored" check.
				if (result.status === "restored") acted++;
				else noop++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`Failed to restore ${tool}: ${msg}`);
			failed++;
		}
	}

	if (acted === 0 && failed === 0 && noop > 0) {
		console.error("No backups found. Nothing to restore.");
		return 1;
	}
	return failed > 0 ? 1 : 0;
}
