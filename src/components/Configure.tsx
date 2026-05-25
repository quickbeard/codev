import { Box, Text } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type InstallWarning,
	JETBRAINS_HINT,
	VSCODE_HINT,
} from "@/components/Install.js";
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
import { CONTINUE_INTELLIJ_PLUGIN_ID } from "@/lib/jetbrains.js";
import { CONTINUE_EXTENSION_ID } from "@/lib/vscode.js";

interface ConfigureProps {
	tools: Tool[];
	// `null` means skip writing CoDev's config; only create the backup.
	creds: Credentials | null;
	// When true, the final resume message merges in the shim-activation hint
	// (platform-aware: `exec $SHELL` on Unix, "Restart your terminal" on Win).
	shimsInstalled?: boolean;
	// Warnings emitted by the Install step (Continue extension/plugin
	// auto-install soft fails). Configure surfaces each one as a yellow
	// hint pointing at the marketplace + manual CLI command.
	installWarnings?: InstallWarning[];
	onDone: (success: boolean) => void;
}

type Phase = "running" | "done" | "error";

const LABEL: Record<BackupKind, string> = {
	"claude-settings": "Claude Code",
	"codex-config": "Codex",
	"opencode-config": "OpenCode",
	"continue-config": "Continue",
};

// With shims installed, users launch agents by the bare binary name; the
// shim forwards through `codev <agent>` transparently. Neither Continue
// editor is a CoDev shim target — `code` is VS Code's own binary, the
// JetBrains launchers are user-managed, and `*-continue` here drives the
// resume hint, not a shimmed command.
const RUN_CMD: Record<Tool, string> = {
	"claude-code": "claude",
	codex: "codex",
	opencode: "opencode",
	"vscode-continue": "code",
	"jetbrains-continue": "your JetBrains IDE",
};

// Without shims (best-effort install failed), the bare command isn't on
// PATH, so fall back to the always-working `codev <agent>` form. Continue
// editors have no CoDev launcher — keep the user-facing wording the same
// as RUN_CMD; the user runs them directly.
const RUN_CMD_FALLBACK: Record<Tool, string> = {
	"claude-code": "codev claude",
	codex: "codev codex",
	opencode: "codev opencode",
	"vscode-continue": "code",
	"jetbrains-continue": "your JetBrains IDE",
};

// `vscode-continue`/`jetbrains-continue` render as plain text rather than
// a cyan code block — they aren't literal shell commands. Avoids painting
// "your JetBrains IDE" as a fake snippet.
function isShellCommand(tool: Tool): boolean {
	return tool !== "vscode-continue" && tool !== "jetbrains-continue";
}

function resumeMessage(tools: Tool[], shimsInstalled: boolean): ReactNode {
	if (tools.length === 0) return null;
	const cmdMap = shimsInstalled ? RUN_CMD : RUN_CMD_FALLBACK;
	const parts = tools.flatMap((t, i) => {
		const text = cmdMap[t];
		const cmd = isShellCommand(t) ? (
			<Text key={t} color="cyan">
				{text}
			</Text>
		) : (
			<Text key={t}>{text}</Text>
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
	installWarnings = [],
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

	const vscodeWarning = installWarnings.find(
		(w) => w.tool === "vscode-continue",
	);
	const jetbrainsWarning = installWarnings.find(
		(w) => w.tool === "jetbrains-continue",
	);

	return (
		<Box flexDirection="column">
			{logs.map((log, i) => (
				<Text key={`cfg-${i.toString()}`}>{log}</Text>
			))}
			{phase === "done" && (
				<Box marginBottom={1} flexDirection="column">
					{resumeMessage(tools, shimsInstalled)}
					{vscodeWarning && (
						<Text color="yellow">
							{`Continue extension auto-install did not complete (${vscodeWarning.message}). ${VSCODE_HINT} Alternatively, run `}
							<Text color="cyan">{`code --install-extension ${CONTINUE_EXTENSION_ID}`}</Text>
							{
								" once `code` is on PATH (in VS Code: Command Palette → \"Shell Command: Install 'code' command in PATH\")."
							}
						</Text>
					)}
					{jetbrainsWarning && (
						<Text color="yellow">
							{`Continue plugin auto-install did not complete (${jetbrainsWarning.message}). ${JETBRAINS_HINT} Alternatively, run `}
							<Text color="cyan">{`<idea|pycharm|goland> installPlugins ${CONTINUE_INTELLIJ_PLUGIN_ID}`}</Text>
							{
								" once a JetBrains shell launcher is on PATH (Toolbox → Settings → Tools → Generate shell scripts)."
							}
						</Text>
					)}
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
