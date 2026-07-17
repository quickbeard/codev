import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import { YesNo } from "@/components/YesNo.js";
import { type RemoveResult, runRemove } from "@/lib/remove.js";

type Phase = "confirm" | "running" | "done" | "aborted";

interface RemoveAppProps {
	skipConfirm?: boolean;
	// Undocumented escape hatch (`--force`): deletes backup-less configs whoever
	// wrote them, instead of preserving the ones that aren't CoDev's. Not in
	// help.ts and intentionally unadvertised, so the only way here is to type it.
	force?: boolean;
}

export function RemoveApp({
	skipConfirm = false,
	force = false,
}: RemoveAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>(
		skipConfirm ? "running" : "confirm",
	);
	const [result, setResult] = useState<RemoveResult | null>(null);
	const hasRun = useRef(false);

	const start = useCallback(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runRemove(force)
			.then((r) => {
				setResult(r);
				setPhase("done");
			})
			.catch((err: unknown) => {
				setResult({
					steps: [
						{
							label: "Remove",
							detail: err instanceof Error ? err.message : String(err),
							status: "failed",
						},
					],
					anyFailed: true,
					keptPaths: [],
				});
				setPhase("done");
			});
	}, [force]);

	useEffect(() => {
		if (phase === "running") start();
	}, [phase, start]);

	// Defer exit() until after the post-completion frame has rendered. Calling
	// exit() inline with setPhase("done") would unmount before ink flushes the
	// new frame, hiding the success / failure / abort message.
	useEffect(() => {
		if (phase === "done") {
			exit(result?.anyFailed ? new Error("remove failed") : undefined);
		} else if (phase === "aborted") {
			exit(new Error("aborted"));
		}
	}, [phase, result, exit]);

	const handleAnswer = useCallback((proceed: boolean) => {
		setPhase(proceed ? "running" : "aborted");
	}, []);

	if (phase === "confirm") {
		return (
			<Box flexDirection="column">
				<Text bold color="yellow">
					Everything will be reverted to the pre-CoDev state. Do you want to
					proceed?
				</Text>
				<Box marginTop={1}>
					<YesNo defaultAnswer="no" onAnswer={handleAnswer} />
				</Box>
			</Box>
		);
	}

	if (phase === "aborted") {
		return <Text>Abort.</Text>;
	}

	if (phase === "running" || !result) {
		return (
			<Box>
				<Text color="cyan">
					<Spinner />
				</Text>
				<Text> Removing CoDev components...</Text>
			</Box>
		);
	}

	// Non-fatal warnings (e.g. CodeGraph was already removed) are shown
	// in both the success and failure views so the user always sees them.
	const warnings = result.steps.filter((s) => s.status === "warning");
	const warningRows = warnings.map((s) => (
		<Text key={s.label} color="yellow">
			▲ {s.label}: {s.detail}
		</Text>
	));

	// Configs CoDev wrote are deleted outright, so they need no follow-up. These
	// are the ones we identified as the user's own and deliberately preserved —
	// report them so the removal's scope is clear, not as a chore list.
	const keptHint =
		result.keptPaths.length > 0 ? (
			<Box flexDirection="column" marginTop={1}>
				<Text color="yellow">
					Kept {result.keptPaths.length} config file
					{result.keptPaths.length === 1 ? "" : "s"} CoDev didn't write — your
					own settings were left untouched:
				</Text>
				{result.keptPaths.map((p) => (
					<Text key={p} dimColor>
						- {p}
					</Text>
				))}
			</Box>
		) : null;

	if (result.anyFailed) {
		const failures = result.steps.filter((s) => s.status === "failed");
		return (
			<Box flexDirection="column">
				{warningRows}
				<Text color="red">✗ Some steps failed:</Text>
				{failures.map((s) => (
					<Text key={s.label} dimColor>
						- {s.label}: {s.detail}
					</Text>
				))}
				{keptHint}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{warningRows}
			<Text>
				{"Removed successfully. You can now run "}
				<Text color="cyan">npm uninstall -g codev-ai</Text>
				{" to remove the CoDev package. Restart your terminal to apply."}
			</Text>
			{keptHint}
		</Box>
	);
}
