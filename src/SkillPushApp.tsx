import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import { useCanType } from "@/components/useCanType.js";
import { type AuthData, loadAuth } from "@/lib/auth.js";
import { type MessageKey, t, tCount } from "@/lib/i18n.js";
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

// Message keys rather than resolved labels: a Record of strings here would
// freeze the English text at import time.
const STEP_LABEL_KEYS = {
	upload: "skill_push.step.uploading",
	metadata: "skill_push.step.saving",
	submit: "skill_push.step.submitting",
	approve: "skill_push.step.approving",
} as const satisfies Record<PublishStep, MessageKey>;

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
	if (opts.draftOnly) return t("skill_push.mode.draft");
	if (opts.autoApprove) return t("skill_push.mode.auto_approve");
	return t("skill_push.mode.submit");
}

export function SkillPushApp({
	path,
	json,
	draftOnly,
	autoApprove,
	onDone,
}: SkillPushAppProps) {
	const { exit } = useApp();
	const canType = useCanType();
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

	// The dispatcher already routes a keyboard-less terminal to the plain runner,
	// so reaching "confirm" without one means Ink's stdin isn't the process's own.
	// Bail rather than mount a confirmation nobody can answer — and never assume
	// consent from the silence: this step is the last thing standing between the
	// user and an upload.
	useEffect(() => {
		if (phase !== "confirm" || canType) return;
		setError(t("skill_push.no_keyboard"));
		setPhase("error");
		finish(false);
	}, [phase, canType, finish]);

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
		{ isActive: canType && phase === "confirm" },
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
					title={<Text bold>{t("skill_push.title")}</Text>}
				>
					{phase === "preparing" ? (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{` ${t("skill_push.preparing")}`}</Text>
						</Box>
					) : archive ? (
						<Box flexDirection="column">
							<Text>
								{tCount("skill_push.archive", archive.files.length, {
									fileName: archive.fileName,
									size: formatBytes(archive.totalBytes),
								})}
							</Text>
							{archive.files.slice(0, MAX_PREVIEW_FILES).map((f) => (
								<Text key={f} dimColor>
									{`  • ${f}`}
								</Text>
							))}
							{archive.files.length > MAX_PREVIEW_FILES && (
								<Text dimColor>
									{t("skill_push.and_more", {
										count: archive.files.length - MAX_PREVIEW_FILES,
									})}
								</Text>
							)}
							{archive.skipped.length > 0 && (
								<Text color="yellow">
									{t("skill_push.excluded", {
										list: archive.skipped.join(", "),
									})}
								</Text>
							)}
							<Box marginTop={1} flexDirection="column">
								<Text dimColor>{actionSummary(opts)}</Text>
								{phase === "confirm" && (
									<Text>
										{`${t("skill_push.confirm")} `}
										<Text color="cyan">(y/N)</Text>
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
								<Text>{` ${t("skill_push.checking_signin")}`}</Text>
							</Box>
						) : phase === "login" ? (
							<Login onDone={handleLoginDone} />
						) : (
							<Text color="green">
								{loginEmail
									? t("login.signed_in_as", { email: loginEmail })
									: t("login.signed_in")}
							</Text>
						)}
					</Step>
				)}

				{/* Step 3 — publish progress + result. */}
				{(phase === "publishing" || phase === "done" || started) && (
					<Step
						active={phase === "publishing" || phase === "error"}
						title={<Text bold>{t("skill_push.publishing")}</Text>}
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
									>{` ${t(STEP_LABEL_KEYS[step])}`}</Text>
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
						<Text dimColor>{t("skill_push.cancelled")}</Text>
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
