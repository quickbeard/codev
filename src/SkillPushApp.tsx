import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import {
	formatPublishResult,
	type PublishArchive,
	type PublishOpts,
	type PublishResult,
	type PublishStep,
	plannedSteps,
	preparePublishArchive,
	publishSkill,
} from "@/lib/skill-publish.js";

interface SkillPushAppProps {
	path: string;
	json: boolean;
	draftOnly: boolean;
	autoApprove: boolean;
	// Reports success/failure so the caller can set the process exit code, then
	// the app exits on its own. Optional so tests can omit it.
	onDone?: (ok: boolean) => void;
}

type Phase =
	| "preparing"
	| "confirm"
	| "publishing"
	| "done"
	| "cancelled"
	| "error";
type StepState = "pending" | "running" | "done";

const STEP_LABELS: Record<PublishStep, string> = {
	upload: "Uploading",
	metadata: "Saving metadata",
	submit: "Submitting for review",
	approve: "Approving (admin)",
};

const MAX_PREVIEW_FILES = 12;

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function actionSummary(opts: PublishOpts): string {
	if (opts.draftOnly) return "Save as a DRAFT (not submitted).";
	if (opts.autoApprove) {
		return "Upload, submit, and auto-approve to PUBLIC (admin only).";
	}
	return "Upload and submit for review.";
}

export function SkillPushApp({
	path,
	json,
	draftOnly,
	autoApprove,
	onDone,
}: SkillPushAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("preparing");
	const [archive, setArchive] = useState<PublishArchive | null>(null);
	const [result, setResult] = useState<PublishResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const opts: PublishOpts = { draftOnly, autoApprove };
	const steps = plannedSteps(opts);
	const [stepState, setStepState] = useState<Record<PublishStep, StepState>>({
		upload: "pending",
		metadata: "pending",
		submit: "pending",
		approve: "pending",
	});

	// Signal the outcome, then unmount. exit() takes no error — the exit code is
	// carried by onDone — so waitUntilExit resolves cleanly either way.
	const finish = useCallback(
		(ok: boolean) => {
			onDone?.(ok);
			// Hold a final frame briefly so it's readable; drop fast on failure.
			setTimeout(() => exit(), ok ? 500 : 20);
		},
		[onDone, exit],
	);

	// Build the archive up front so the confirm step can show what will ship.
	useEffect(() => {
		let cancelled = false;
		preparePublishArchive(path)
			.then((a) => {
				if (cancelled) return;
				setArchive(a);
				setPhase("confirm");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				finish(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path, finish]);

	const start = useCallback(async () => {
		if (!archive) return;
		setPhase("publishing");
		try {
			const r = await publishSkill(
				archive,
				{ draftOnly, autoApprove },
				(step, status) => {
					setStepState((prev) => ({
						...prev,
						[step]: status === "start" ? "running" : "done",
					}));
				},
			);
			setResult(r);
			setPhase("done");
			finish(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			finish(false);
		}
	}, [archive, draftOnly, autoApprove, finish]);

	useInput(
		(input, key) => {
			if (phase !== "confirm") return;
			if (key.return || input.toLowerCase() === "y") {
				void start();
			} else if (key.escape || input.toLowerCase() === "n") {
				setPhase("cancelled");
				finish(false);
			}
		},
		{ isActive: phase === "confirm" },
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step active title={<Text bold>Publish skill to the hub</Text>}>
					{phase === "preparing" && (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{" Preparing archive..."}</Text>
						</Box>
					)}

					{phase === "confirm" && archive && (
						<Box flexDirection="column">
							<Text>
								{`${archive.fileName}  (${archive.files.length} file${
									archive.files.length === 1 ? "" : "s"
								}, ${formatBytes(archive.totalBytes)})`}
							</Text>
							{archive.files.slice(0, MAX_PREVIEW_FILES).map((f) => (
								<Text key={f} dimColor>
									{`  • ${f}`}
								</Text>
							))}
							{archive.files.length > MAX_PREVIEW_FILES && (
								<Text dimColor>
									{`  … and ${archive.files.length - MAX_PREVIEW_FILES} more`}
								</Text>
							)}
							{archive.skipped.length > 0 && (
								<Text color="yellow">
									{`Excluded: ${archive.skipped.join(", ")}`}
								</Text>
							)}
							<Box marginTop={1} flexDirection="column">
								<Text dimColor>{actionSummary(opts)}</Text>
								<Text>
									Publish this skill? <Text color="cyan">(y/N)</Text>
								</Text>
							</Box>
						</Box>
					)}

					{(phase === "publishing" || phase === "done") && (
						<Box flexDirection="column">
							{steps.map((step) => {
								const state = stepState[step];
								return (
									<Box key={step}>
										{state === "running" ? (
											<Text color="cyan">
												<Spinner />
											</Text>
										) : (
											<Text color={state === "done" ? "green" : "gray"}>
												{state === "done" ? "✓" : "○"}
											</Text>
										)}
										<Text
											color={state === "pending" ? "gray" : undefined}
										>{` ${STEP_LABELS[step]}`}</Text>
									</Box>
								);
							})}
							{phase === "done" && result && (
								<Box marginTop={1}>
									<Text color={json ? undefined : "green"}>
										{formatPublishResult(result, json)}
									</Text>
								</Box>
							)}
						</Box>
					)}

					{phase === "cancelled" && <Text dimColor>Cancelled.</Text>}
					{phase === "error" && error && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
