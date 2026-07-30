import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import { type AuthData, loadAuth } from "@/lib/auth.js";
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
import { hasSkillhubAuth } from "@/lib/skillhub.js";

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
	| "authing"
	| "login"
	| "publishing"
	| "done"
	| "cancelled"
	| "error";
type StepState = "pending" | "running" | "done" | "failed";

const STEP_LABELS: Record<PublishStep, string> = {
	upload: "Uploading",
	metadata: "Saving metadata",
	submit: "Submitting for review",
	approve: "Approving (admin)",
};

// Marker glyph/color for a non-running step ("running" renders a spinner
// instead, so its entries here are unused placeholders).
const MARK_GLYPH: Record<StepState, string> = {
	pending: "○",
	running: "",
	done: "✓",
	failed: "✗",
};
const MARK_COLOR: Record<StepState, string> = {
	pending: "gray",
	running: "cyan",
	done: "green",
	failed: "red",
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
	// The signed-in identity to show in the Login step (from a fresh login or an
	// existing session). Null falls back to a plain "Signed in".
	const [loginEmail, setLoginEmail] = useState<string | null>(null);

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
			// Mark whichever step was in flight as failed, so it shows a ✗ instead
			// of a frozen spinner next to the error.
			setStepState((prev) => {
				const next = { ...prev };
				for (const k of Object.keys(next) as PublishStep[]) {
					if (next[k] === "running") next[k] = "failed";
				}
				return next;
			});
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			finish(false);
		}
	}, [archive, draftOnly, autoApprove, finish]);

	// Login succeeded: record who, then publish. login() has already persisted
	// the session, so the upcoming skillhubFetch calls pick it up.
	const handleLoginDone = useCallback(
		(authData: AuthData) => {
			setLoginEmail(authData.user.email);
			void start();
		},
		[start],
	);

	useInput(
		(input, key) => {
			if (phase !== "confirm") return;
			// Gate login at the commit point: only after the user confirms do we
			// check credentials, so cancelling never triggers a browser login.
			if (key.return || input.toLowerCase() === "y") {
				setPhase("authing");
			} else if (key.escape || input.toLowerCase() === "n") {
				setPhase("cancelled");
				finish(false);
			}
		},
		{ isActive: phase === "confirm" },
	);

	// After confirmation: if a credential is already available, record the
	// identity and publish (the Login step still renders, showing "Signed in");
	// otherwise fall into the interactive login step.
	useEffect(() => {
		if (phase !== "authing") return;
		let cancelled = false;
		hasSkillhubAuth()
			.then((ok) => {
				if (cancelled) return;
				if (ok) {
					// SSO sessions carry an email; an admin-cookie session doesn't, so
					// it falls back to a plain "Signed in".
					setLoginEmail(loadAuth()?.user.email ?? null);
					void start();
				} else {
					setPhase("login");
				}
			})
			.catch(() => {
				if (!cancelled) setPhase("login");
			});
		return () => {
			cancelled = true;
		};
	}, [phase, start]);

	// Whether publishing has begun (any step left "pending"), so the progress
	// step stays rendered even after an error mid-pipeline.
	const started = Object.values(stepState).some((s) => s !== "pending");

	return (
		<Box flexDirection="column" paddingX={1} paddingBottom={1}>
			<Banner />
			<Frame tag="CoDev">
				{/* Step 1 — archive preview + confirm. Stays visible (dimmed) through
				    login and publishing so the user always sees what they're shipping. */}
				<Step
					active={phase === "preparing" || phase === "confirm"}
					title={<Text bold>Publish skill to the hub</Text>}
				>
					{phase === "preparing" ? (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{" Preparing archive..."}</Text>
						</Box>
					) : archive ? (
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
								{phase === "confirm" && (
									<Text>
										Publish this skill? <Text color="cyan">(y/N)</Text>
									</Text>
								)}
							</Box>
						</Box>
					) : null}
				</Step>

				{/* Step 2 — login. Shown once the user commits (not on cancel): the
				    credential check, the interactive sign-in (only when logged out),
				    and then a persistent "✓ Signed in" line. */}
				{(phase === "authing" ||
					phase === "login" ||
					phase === "publishing" ||
					phase === "done" ||
					(phase === "error" && started)) && (
					<Step
						active={phase === "authing" || phase === "login"}
						title={loginTitle()}
					>
						{phase === "authing" ? (
							<Box>
								<Text color="cyan">
									<Spinner />
								</Text>
								<Text>{" Checking sign-in..."}</Text>
							</Box>
						) : phase === "login" ? (
							<Login onDone={handleLoginDone} />
						) : (
							<Text color="green">
								{`✓ Signed in${loginEmail ? ` as ${loginEmail}` : ""}`}
							</Text>
						)}
					</Step>
				)}

				{/* Step 3 — publish progress + result. */}
				{(phase === "publishing" || phase === "done" || started) && (
					<Step
						active={phase === "publishing" || phase === "error"}
						title={<Text bold>Publishing</Text>}
					>
						{steps.map((step) => {
							const state = stepState[step];
							return (
								<Box key={step}>
									{state === "running" ? (
										<Text color="cyan">
											<Spinner />
										</Text>
									) : (
										<Text color={MARK_COLOR[state]}>{MARK_GLYPH[state]}</Text>
									)}
									<Text
										color={
											state === "failed"
												? "red"
												: state === "pending"
													? "gray"
													: undefined
										}
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
					</Step>
				)}

				{phase === "cancelled" && (
					<Box marginTop={1}>
						<Text dimColor>Cancelled.</Text>
					</Box>
				)}
				{phase === "error" && error && (
					<Box marginTop={1}>
						<Text color="red">{error}</Text>
					</Box>
				)}
			</Frame>
		</Box>
	);
}
