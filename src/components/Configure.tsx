import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import {
	type BackupKind,
	backupOnly,
	type ConfigureResult,
	type Credentials,
	configureClaudeCode,
	configureCodex,
	configureContinue,
	configureOpenCode,
	kindForTool,
	type Tool,
} from "@/lib/configure.js";
import { logError, logInfo } from "@/lib/log.js";

interface ConfigureProps {
	tools: Tool[];
	// `null` means skip writing CoDev's config; only create the backup.
	creds: Credentials | null;
	onDone: (success: boolean) => void;
}

type Phase = "running" | "done" | "error";

// `claude-json` and `claude-credentials` never flow through Configure (the
// install flow's finalize Phase owns them). The entries exist for
// Record<BackupKind, string> type completeness only.
const LABEL: Record<BackupKind, string> = {
	"claude-settings": "Claude Code",
	"claude-json": "Claude Code (onboarding)",
	"claude-credentials": "Claude Code (credentials)",
	"codex-config": "Codex",
	"opencode-config": "OpenCode",
	"continue-config": "Continue",
};

export function Configure({ tools, creds, onDone }: ConfigureProps) {
	const [phase, setPhase] = useState<Phase>("running");
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	useEffect(() => {
		if (phase !== "running" || hasRun.current) return;
		hasRun.current = true;
		try {
			// Dedupe by BackupKind so a `vscode-continue` + `jetbrains-continue`
			// selection writes ~/.continue/config.yaml once and emits one row.
			// Same for Claude Code CLI + extension variants, which all share
			// ~/.claude/settings.json.
			const seen = new Set<BackupKind>();
			const results: ConfigureResult[] = [];
			for (const tool of tools) {
				const kind = kindForTool(tool);
				if (seen.has(kind)) continue;
				seen.add(kind);
				if (creds === null) {
					results.push(...backupOnly(tool));
				} else if (
					tool === "claude-code" ||
					tool === "vscode-claude-code" ||
					tool === "jetbrains-claude-code"
				) {
					results.push(...configureClaudeCode(creds));
				} else if (tool === "codex") {
					results.push(...configureCodex(creds));
				} else if (tool === "opencode") {
					results.push(...configureOpenCode(creds));
				} else if (
					tool === "vscode-continue" ||
					tool === "jetbrains-continue"
				) {
					results.push(...configureContinue(creds));
				}
			}
			logInfo(`configured ${results.length} config file(s)`, {
				action: "configure.tool",
				outcome: "success",
				extra: {
					backup_only: creds === null,
					kinds: results.map((r) => r.kind),
					backups_created: results.filter((r) => r.created).length,
				},
			});
			// Skip-configuration (creds === null) still runs backupOnly above for
			// its side-effects, but renders no rows — SetupApp hides the whole
			// Step on that path. Only the configure path emits visible output.
			if (creds !== null) {
				setLogs(results.map((r) => `Configured ${LABEL[r.kind]}`));
			}
			setPhase("done");
			// Hand off immediately. SetupApp's finalize Phase owns the visible
			// pause before exit so the "Configured X" + "Happy coding!" rows
			// render together rather than in two staggered beats.
			onDone(true);
		} catch (err) {
			logError("configure failed", {
				action: "configure.tool",
				outcome: "failure",
				err,
				extra: { tools },
			});
			setError((err as Error).message);
			setPhase("error");
			onDone(false);
		}
	}, [phase, tools, creds, onDone]);

	return (
		<Box flexDirection="column">
			{logs.map((log, i) => (
				<Text key={`cfg-${i.toString()}`}>{log}</Text>
			))}
			{error && <Text color="red">{`Configure failed: ${error}`}</Text>}
		</Box>
	);
}

export function configureTitle() {
	return <Text bold>Configure tools</Text>;
}
