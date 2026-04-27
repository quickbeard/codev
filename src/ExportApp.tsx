import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { HAPPY_CODING } from "@/const.js";
import { type ExportSummary, runExport } from "@/export.js";
import type { Agent } from "@/providers/types.js";

type Phase = "running" | "done" | "error";

const AGENT_LABEL: Record<Agent, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
};

// Fixed display order for the per-agent breakdown so output is stable across
// runs and unaffected by detection-loop ordering.
const AGENT_ORDER: Agent[] = ["claude-code", "codex", "opencode"];

export function ExportApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("running");
	const [status, setStatus] = useState("Exporting logs...");
	const [summary, setSummary] = useState<ExportSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runExport(setStatus)
			.then((result) => {
				setSummary(result);
				setPhase("done");
			})
			.catch((err) => {
				setError(String(err));
				setPhase("error");
			});
	}, []);

	// Calling exit() inside the work promise races React's commit phase: Ink
	// can unmount before the terminal frame ("done"/"error" with the summary)
	// is flushed. Defer to a separate effect that fires after the terminal
	// state has rendered.
	useEffect(() => {
		if (phase === "done" || phase === "error") {
			exit();
		}
	}, [phase, exit]);

	if (phase === "running") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner />
				</Text>
				<Text> {status}</Text>
			</Box>
		);
	}

	if (phase === "error") {
		return (
			<Box flexDirection="column">
				<Text color="red">✗ Export failed</Text>
				<Text dimColor>{error ?? "unknown error"}</Text>
			</Box>
		);
	}

	const result = summary;
	if (!result) return null;

	const skippedSet = new Set(result.skipped);
	const errorByAgent = new Map(result.errors.map((e) => [e.agent, e.message]));

	return (
		<Box flexDirection="column">
			<Text color="green">
				✓ Exported {result.exported}{" "}
				{result.exported === 1 ? "session" : "sessions"} to {result.outDir}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{AGENT_ORDER.map((agent) => {
					const count = result.byAgent[agent] ?? 0;
					const errorMsg = errorByAgent.get(agent);
					if (errorMsg) {
						return (
							<Text key={agent} color="yellow">
								- {AGENT_LABEL[agent]}: error: {errorMsg}
							</Text>
						);
					}
					const suffix = skippedSet.has(agent) ? " (no activity here)" : "";
					return (
						<Text key={agent} dimColor>
							- {AGENT_LABEL[agent]}: {count}
							{suffix}
						</Text>
					);
				})}
			</Box>
			<Box marginTop={1} marginBottom={1}>
				<Text bold color="magenta">
					{HAPPY_CODING}
				</Text>
			</Box>
		</Box>
	);
}
