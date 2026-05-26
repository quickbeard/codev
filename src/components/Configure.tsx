import { Box, Text } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
import { HAPPY_CODING, HELP_HINT } from "@/lib/const.js";

interface ConfigureProps {
	tools: Tool[];
	// `null` means skip writing CoDev's config; only create the backup.
	creds: Credentials | null;
	// When true, the final resume message merges in the shim-activation hint
	// (platform-aware: `exec $SHELL` on Unix, "Restart your terminal" on Win).
	shimsInstalled?: boolean;
	onDone: (success: boolean) => void;
}

type Phase = "running" | "done" | "error";

const LABEL: Record<BackupKind, string> = {
	"claude-settings": "Claude Code",
	"codex-config": "Codex",
	"opencode-config": "OpenCode",
	"continue-config": "Continue",
};

function resumeMessage(tools: Tool[], shimsInstalled: boolean): ReactNode {
	if (tools.length === 0) return null;
	if (!shimsInstalled) {
		return <Text>Done!</Text>;
	}
	if (process.platform === "win32") {
		return <Text>Done! Restart your terminal.</Text>;
	}
	return (
		<Text>
			{"Done! Run "}
			<Text color="cyan">exec $SHELL</Text>
			{" to reload your shell."}
		</Text>
	);
}

function describeResult(r: ConfigureResult, skipped: boolean): string[] {
	if (skipped) {
		if (!r.backupPath) return [`Nothing to back up for ${LABEL[r.kind]}`];
		if (r.created) return [`Backed up ${LABEL[r.kind]}`];
		return [`${LABEL[r.kind]} backup already exists — left untouched`];
	}
	return [`Configured ${LABEL[r.kind]}`];
}

export function Configure({
	tools,
	creds,
	shimsInstalled = false,
	onDone,
}: ConfigureProps) {
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
			const seen = new Set<BackupKind>();
			const results: ConfigureResult[] = [];
			for (const tool of tools) {
				const kind = kindForTool(tool);
				if (seen.has(kind)) continue;
				seen.add(kind);
				if (creds === null) {
					results.push(...backupOnly(tool));
				} else if (tool === "claude-code") {
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
			setTimeout(() => onDone(true), 1000);
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
			{phase === "done" && (
				<Box marginBottom={1} flexDirection="column">
					{resumeMessage(tools, shimsInstalled)}
					<Box marginTop={1}>
						<Text dimColor>{HELP_HINT}</Text>
					</Box>
					<Text bold color="magenta">
						{HAPPY_CODING}
					</Text>
				</Box>
			)}
			{error && <Text color="red">{`Configure failed: ${error}`}</Text>}
		</Box>
	);
}

export function configureTitle(skip = false) {
	return (
		<Text bold>{skip ? "Back up existing configs" : "Configure tools"}</Text>
	);
}
