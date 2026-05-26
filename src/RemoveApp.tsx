import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import { YesNo } from "@/components/YesNo.js";
import { type RemoveResult, runRemove } from "@/lib/remove.js";

type Phase = "confirm" | "running" | "done" | "aborted";

interface RemoveAppProps {
	skipConfirm?: boolean;
}

export function RemoveApp({ skipConfirm = false }: RemoveAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>(
		skipConfirm ? "running" : "confirm",
	);
	const [result, setResult] = useState<RemoveResult | null>(null);
	const hasRun = useRef(false);

	const start = useCallback(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runRemove()
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
				});
				setPhase("done");
			});
	}, []);

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

	if (result.anyFailed) {
		const failures = result.steps.filter((s) => s.status === "failed");
		return (
			<Box flexDirection="column">
				<Text color="red">✗ Some steps failed:</Text>
				{failures.map((s) => (
					<Text key={s.label} dimColor>
						- {s.label}: {s.detail}
					</Text>
				))}
			</Box>
		);
	}

	return (
		<Text>
			{"Removed successfully. You can now run "}
			<Text color="cyan">npm uninstall -g codev-ai</Text>
			{" to remove the CoDev package. Restart your terminal to apply."}
		</Text>
	);
}
