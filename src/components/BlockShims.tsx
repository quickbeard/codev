import { homedir } from "node:os";
import { relative } from "node:path";
import { Box, Text } from "ink";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { activationHint, installShims, type ShimResult } from "@/lib/shims.js";

interface BlockShimsProps {
	onDone: (success: boolean) => void;
}

type Phase = "running" | "done" | "error";

function tilde(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) {
		return `~/${relative(home, path).replace(/\\/g, "/")}`;
	}
	return path;
}

function describe(result: ShimResult): string[] {
	const lines: string[] = [];
	lines.push(
		`Installed shims for ${result.shimsWritten.join(", ")} in ${tilde(result.shimDir)}`,
	);
	for (const path of result.rcFilesUpdated) {
		lines.push(`Patched ${tilde(path)}`);
	}
	if (result.windowsUserPathUpdated) {
		lines.push("Prepended shim dir to your user PATH (cmd.exe)");
	}
	return lines;
}

export function BlockShims({ onDone }: BlockShimsProps) {
	const [phase, setPhase] = useState<Phase>("running");
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	useEffect(() => {
		if (phase !== "running" || hasRun.current) return;
		hasRun.current = true;
		try {
			const result = installShims();
			setLogs(describe(result));
			setPhase("done");
			onDone(true);
		} catch (err) {
			setError((err as Error).message);
			setPhase("error");
			onDone(false);
		}
	}, [phase, onDone]);

	return (
		<Box flexDirection="column">
			{logs.map((log, i) => (
				<Text key={`shim-${i.toString()}`}>{log}</Text>
			))}
			{phase === "done" && (
				<Box marginTop={1}>
					<Text dimColor>{activationHint()}</Text>
				</Box>
			)}
			{error && <Text color="red">{`Shim setup failed: ${error}`}</Text>}
		</Box>
	);
}

export function blockShimsTitle(): ReactNode {
	return <Text bold>Blocking direct agent commands</Text>;
}
