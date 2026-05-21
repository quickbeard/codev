import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import { type RemoveResult, runRemove } from "@/lib/remove.js";

type Phase = "confirm" | "running" | "done" | "cancelled";

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
	// new frame, hiding the success / failure message.
	useEffect(() => {
		if (phase === "done") {
			exit(result?.anyFailed ? new Error("remove failed") : undefined);
		} else if (phase === "cancelled") {
			exit();
		}
	}, [phase, result, exit]);

	useInput(
		(input, key) => {
			const answer = input.toLowerCase();
			if (answer === "y") {
				setPhase("running");
			} else if (answer === "n" || key.return) {
				setPhase("cancelled");
			}
		},
		{ isActive: phase === "confirm" },
	);

	if (phase === "confirm") {
		return (
			<Box flexDirection="column">
				<Text bold color="yellow">
					Everything will be reverted to the pre-CoDev state. Do you want to
					proceed?
				</Text>
				<Box marginTop={1}>
					<Text color="cyan">Continue? [y/N]</Text>
				</Box>
			</Box>
		);
	}

	if (phase === "cancelled") {
		return <Text>Cancelled.</Text>;
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
