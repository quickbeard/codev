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

function describeResult(r: ConfigureResult, skipped: boolean): string[] {
	if (skipped) {
		if (!r.backupPath) return [`Nothing to back up for ${LABEL[r.kind]}`];
		if (r.created) return [`Backed up ${LABEL[r.kind]}`];
		return [`${LABEL[r.kind]} backup already exists — left untouched`];
	}
	return [`Configured ${LABEL[r.kind]}`];
}

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
			const next: string[] = [];
			for (const r of results) {
				next.push(...describeResult(r, creds === null));
			}
			setLogs(next);
			setPhase("done");
			// Hand off immediately. SetupApp's finalize Phase owns the visible
			// pause before exit so the "Configured X" + "Happy coding!" rows
			// render together rather than in two staggered beats.
			onDone(true);
		} catch (err) {
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

export function configureTitle(skip = false) {
	return (
		<Text bold>{skip ? "Back up existing configs" : "Configure tools"}</Text>
	);
}
