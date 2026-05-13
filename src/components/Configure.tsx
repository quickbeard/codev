import { Box, Text } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type BackupKind,
	backupOnly,
	type ConfigureResult,
	type Credentials,
	configureClaudeCode,
	configureCodex,
	configureOpenCode,
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
};

const RUN_CMD: Record<Tool, string> = {
	"claude-code": "codev claude",
	codex: "codev codex",
	opencode: "codev opencode",
};

function resumeMessage(tools: Tool[], shimsInstalled: boolean): ReactNode {
	if (tools.length === 0) return null;
	const parts = tools.flatMap((t, i) => {
		const cmd = (
			<Text key={t} color="cyan">
				{RUN_CMD[t]}
			</Text>
		);
		if (i === 0) return [cmd];
		const sep = i === tools.length - 1 ? " or " : ", ";
		return [sep, cmd];
	});
	if (!shimsInstalled) {
		return (
			<Text>
				{"Done! You can now run "}
				{parts}
				{" to get started."}
			</Text>
		);
	}
	// Shims are installed but won't take effect in the current shell. Merge
	// the activation hint into the resume sentence rather than show it as a
	// separate line.
	if (process.platform === "win32") {
		return (
			<Text>
				{"Done! Restart your terminal, then run "}
				{parts}
				{" to get started."}
			</Text>
		);
	}
	return (
		<Text>
			{"Done! Run "}
			<Text color="cyan">exec $SHELL</Text>
			{" to activate, then "}
			{parts}
			{" to get started."}
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
			const results: ConfigureResult[] = [];
			for (const tool of tools) {
				if (creds === null) {
					results.push(...backupOnly(tool));
				} else if (tool === "claude-code") {
					results.push(...configureClaudeCode(creds));
				} else if (tool === "codex") {
					results.push(...configureCodex(creds));
				} else if (tool === "opencode") {
					results.push(...configureOpenCode(creds));
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
