import { homedir } from "node:os";
import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { CheckList } from "@/components/CheckList.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { ProxyPrompt, proxyPromptTitle } from "@/components/ProxyPrompt.js";
import { Step } from "@/components/Step.js";
import { type AuthData, logout } from "@/lib/auth.js";
import { SSO_URL } from "@/lib/const.js";
import {
	ACCOUNT_CHECKS,
	alreadyRetriedWithProxy,
	buildDoctorReport,
	buildNextSteps,
	type Check,
	type CheckGroup,
	type CheckOutcome,
	type DoctorContext,
	diagnoseError,
	doctorOutcome,
	ENVIRONMENT_CHECKS,
	hasFailure,
	LLM_CHECKS,
	NETWORK_CHECKS,
	recordedCommands,
	runChecks,
	STATE_CHECKS,
	startCommandRecording,
	writeDoctorReport,
} from "@/lib/doctor.js";
import { logDebug } from "@/lib/log.js";
import type { CommandRecord } from "@/lib/npm.js";
import { readProxyEnv } from "@/lib/proxy.js";

type Phase =
	| "preparing"
	| "environment"
	| "network"
	| "proxy-prompt"
	| "login"
	| "account"
	| "llm"
	| "state"
	| "done";

const GROUP_TITLES: Record<CheckGroup, string> = {
	environment: "Environment",
	network: "Network",
	account: "Account & credentials",
	llm: "LLM access",
	state: "This machine",
};

const GROUP_CHECKS: Record<CheckGroup, Check[]> = {
	environment: ENVIRONMENT_CHECKS,
	network: NETWORK_CHECKS,
	account: ACCOUNT_CHECKS,
	llm: LLM_CHECKS,
	state: STATE_CHECKS,
};

// Phases at or after which a group's Step should stay mounted (read-only
// history), mirroring SetupApp's POST_* arrays.
const AFTER: Record<CheckGroup, Phase[]> = {
	environment: [
		"environment",
		"network",
		"proxy-prompt",
		"login",
		"account",
		"llm",
		"state",
		"done",
	],
	network: [
		"network",
		"proxy-prompt",
		"login",
		"account",
		"llm",
		"state",
		"done",
	],
	account: ["account", "llm", "state", "done"],
	llm: ["llm", "state", "done"],
	state: ["state", "done"],
};

const EMPTY: Record<CheckGroup, CheckOutcome[]> = {
	environment: [],
	network: [],
	account: [],
	llm: [],
	state: [],
};

interface DoctorAppProps {
	/** `--force`: wipe the cached SSO session so sign-in is genuinely exercised. */
	force?: boolean;
}

export function DoctorApp({ force = false }: DoctorAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>(
		force ? "preparing" : "environment",
	);
	const [outcomes, setOutcomes] =
		useState<Record<CheckGroup, CheckOutcome[]>>(EMPTY);
	// Login is rendered by <Login>, but its pass/fail still belongs in the
	// summary and the exit code, so it gets an outcome of its own.
	const [loginOutcome, setLoginOutcome] = useState<CheckOutcome | null>(null);
	const [proxyUrl, setProxyUrl] = useState<string | null>(null);
	// Where the machine-readable report landed, so the summary can point at it.
	// null when the write failed — best-effort, never fatal.
	const [reportPath, setReportPath] = useState<string | null>(null);
	// Snapshotted at the terminal phase — the recorder is a mutable buffer, so
	// reading it during render would tear as checks are still finishing.
	const [commands, setCommands] = useState<CommandRecord[]>([]);
	const didPrepRef = useRef(false);
	// Checks mutate the context as they resolve (token → key → gateway URL →
	// models), so it must be a ref: a state read would see a stale snapshot
	// within the same run.
	const ctxRef = useRef<DoctorContext>({});
	const startedRef = useRef<Set<CheckGroup>>(new Set());

	useEffect(() => {
		logDebug(`doctor step: ${phase}`, {
			action: "step.transition",
			extra: { step: phase, command: "doctor" },
		});
	}, [phase]);

	// Start recording before any check runs, so the "Commands run" section can
	// show the user exactly what was executed on their machine.
	useEffect(() => {
		startCommandRecording();
	}, []);

	// --force wipes the cached session first, so `sso-login` measures a real
	// round trip rather than reporting the cache. Same approach as LoginApp.
	useEffect(() => {
		if (!force || didPrepRef.current) return;
		didPrepRef.current = true;
		logout().finally(() => setPhase("environment"));
	}, [force]);

	const runGroup = useCallback((group: CheckGroup, next: Phase) => {
		if (startedRef.current.has(group)) return;
		startedRef.current.add(group);
		runChecks(GROUP_CHECKS[group], ctxRef.current, (outcome) => {
			setOutcomes((prev) => ({
				...prev,
				[group]: [...prev[group], outcome],
			}));
		}).then((results) => {
			// The network group is the proxy gate: a hard failure there is the
			// signal that this machine may need a different proxy than it has.
			// Offered whether or not one is already configured — an earlier
			// revision suppressed it when a proxy was active, on the reasoning
			// that "it's set up, so something else is wrong". That was backwards:
			// a wrong proxy address is among the likeliest reasons the checks
			// failed, and suppressing the prompt left exactly that user with no
			// way to try another one. The only guard is the retry sentinel, so a
			// child that still fails prints its summary instead of asking again.
			if (
				group === "network" &&
				hasFailure(results) &&
				!alreadyRetriedWithProxy()
			) {
				setPhase("proxy-prompt");
				return;
			}
			setPhase(next);
		});
	}, []);

	useEffect(() => {
		if (phase === "environment") runGroup("environment", "network");
		else if (phase === "network") runGroup("network", "login");
		else if (phase === "account") runGroup("account", "llm");
		else if (phase === "llm") runGroup("llm", "state");
		else if (phase === "state") runGroup("state", "done");
	}, [phase, runGroup]);

	const handleProxySubmit = useCallback(
		(url: string | null) => {
			if (!url) {
				// Skipped — keep going so the user still gets the account/LLM
				// results (they may be on a network that needs no proxy) and the
				// full setup instructions at the end.
				setPhase("login");
				return;
			}
			setProxyUrl(url);
			// The re-exec cannot happen here: spawnSync with inherited stdio while
			// Ink owns the TTY corrupts the terminal. Record the intent and let
			// index.tsx act on it once waitUntilExit() has resolved.
			doctorOutcome.retryWithProxy = { http: url, https: url };
			setTimeout(() => exit(), 300);
		},
		[exit],
	);

	const handleLoginDone = useCallback((auth: AuthData) => {
		ctxRef.current.accessToken = auth.access_token;
		setLoginOutcome({
			key: "sso-login",
			label: "Sign in to SSO",
			group: "account",
			status: "pass",
			detail: `Signed in as ${auth.user.email}.`,
		});
		setPhase("account");
	}, []);

	const handleLoginError = useCallback((err: unknown) => {
		const diagnosis = diagnoseError(err, { url: SSO_URL, method: "GET" });
		setLoginOutcome({
			key: "sso-login",
			label: "Sign in to SSO",
			group: "account",
			status: "fail",
			detail: diagnosis.what,
			fix: diagnosis.fix,
			diagnosis,
		});
		// Keep going. The account/LLM checks report themselves as skipped without
		// a token, which tells the reader exactly how far the flow got.
		setPhase("account");
	}, []);

	// Terminal phase: write the report, compute the exit code, then hold the
	// frame briefly so Ink flushes the summary before unmounting.
	useEffect(() => {
		if (phase !== "done") return;
		const all = [
			...outcomes.environment,
			...outcomes.network,
			...(loginOutcome ? [loginOutcome] : []),
			...outcomes.account,
			...outcomes.llm,
		];
		doctorOutcome.exitCode = hasFailure(all) ? 1 : 0;
		// The `state` group is informational, but it belongs in the file — it is
		// what tells support what was already on the machine.
		setCommands(recordedCommands());
		setReportPath(
			writeDoctorReport(
				buildDoctorReport(
					[...all, ...outcomes.state],
					new Date().toISOString(),
					proxyUrl ? { http: proxyUrl, https: proxyUrl } : undefined,
				),
			),
		);
		const timer = setTimeout(() => exit(), 1000);
		return () => clearTimeout(timer);
	}, [phase, outcomes, loginOutcome, proxyUrl, exit]);

	const groupProps = (group: CheckGroup) => {
		const done = outcomes[group];
		const pending = GROUP_CHECKS[group]
			.filter((c) => !done.some((o) => o.key === c.key))
			.map((c) => c.label);
		const active = phase === group;
		return {
			outcomes: done,
			// The head of the pending list is what's executing right now.
			running: active ? (pending[0] ?? null) : null,
			pending: active ? pending.slice(1) : [],
		};
	};

	// What the environment already points at, so the prompt can ask "is this one
	// wrong?" rather than "do you need a proxy?".
	const proxyEnv = readProxyEnv();
	const currentProxy = proxyEnv.httpsProxy ?? proxyEnv.httpProxy;

	const allOutcomes = [
		...outcomes.environment,
		...outcomes.network,
		...(loginOutcome ? [loginOutcome] : []),
		...outcomes.account,
		...outcomes.llm,
		...outcomes.state,
	];
	const nextSteps =
		phase === "done"
			? buildNextSteps(
					allOutcomes,
					proxyUrl ? { http: proxyUrl, https: proxyUrl } : undefined,
				)
			: [];

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				{phase === "preparing" && (
					<Step active title={<Text bold>Signing out previous session</Text>}>
						<Text dimColor>Revoking tokens...</Text>
					</Step>
				)}

				{(["environment", "network"] as const).map(
					(group) =>
						AFTER[group].includes(phase) && (
							<Step
								key={group}
								active={phase === group}
								title={<Text bold>{GROUP_TITLES[group]}</Text>}
							>
								<CheckList {...groupProps(group)} />
							</Step>
						),
				)}

				{phase === "proxy-prompt" && (
					<Step active title={proxyPromptTitle()}>
						<ProxyPrompt
							onSubmit={handleProxySubmit}
							currentProxy={currentProxy}
						/>
					</Step>
				)}

				{phase !== "preparing" &&
					phase !== "environment" &&
					phase !== "network" &&
					phase !== "proxy-prompt" && (
						<Step active={phase === "login"} title={loginTitle()}>
							<Login onDone={handleLoginDone} onError={handleLoginError} />
							{loginOutcome?.status === "fail" && (
								<CheckList
									pending={[]}
									outcomes={[loginOutcome]}
									running={null}
								/>
							)}
						</Step>
					)}

				{(["account", "llm", "state"] as const).map(
					(group) =>
						AFTER[group].includes(phase) && (
							<Step
								key={group}
								active={phase === group}
								title={<Text bold>{GROUP_TITLES[group]}</Text>}
							>
								<CheckList {...groupProps(group)} />
							</Step>
						),
				)}

				{/* `doctor` runs things on someone else's machine, often a
				    locked-down one. What it ran should be answerable from the
				    output, not from the source. */}
				{phase === "done" && commands.length > 0 && (
					<Step title={<Text bold>Commands run</Text>}>
						<Box flexDirection="column">
							{commands.map((c, i) => (
								<Box key={`cmd-${i.toString()}`}>
									<Text color={c.ok ? "green" : "red"}>{c.ok ? "✓" : "✗"}</Text>
									<Text>{` ${c.command}`}</Text>
									<Text dimColor>{`  (${c.durationMs}ms)`}</Text>
								</Box>
							))}
							<Text dimColor>
								{
									"All read-only — doctor never installs, uninstalls or changes configuration."
								}
							</Text>
						</Box>
					</Step>
				)}
				{phase === "done" && (
					<Step title={<Text bold>Result</Text>}>
						<Summary
							outcomes={allOutcomes}
							nextSteps={nextSteps}
							reportPath={reportPath}
						/>
					</Step>
				)}
			</Frame>
		</Box>
	);
}

/**
 * `/Users/minh/.codev-hub/x` → `~/.codev-hub/x`. Shorter (so it does not wrap)
 * and directly usable in a shell — both zsh/bash and PowerShell expand `~`.
 * Returns the path untouched when it is not under the home directory.
 */
function abbreviateHome(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function Summary({
	outcomes,
	nextSteps,
	reportPath,
}: {
	outcomes: CheckOutcome[];
	nextSteps: string[];
	reportPath: string | null;
}) {
	const failed = outcomes.filter((o) => o.status === "fail").length;
	const warned = outcomes.filter((o) => o.status === "warn").length;

	return (
		<Box flexDirection="column">
			{failed === 0 && warned === 0 && (
				<Text color="green">
					{"✓ Everything checks out. You're ready to run `codevhub install`."}
				</Text>
			)}
			{failed === 0 && warned > 0 && (
				<Text color="yellow">
					{`▲ ${warned} warning(s). \`codevhub install\` should work, but read the notes below first.`}
				</Text>
			)}
			{failed > 0 && (
				// Name the warnings too: the Next steps list below numbers failures
				// and warnings together, so a bare "5 failed" above 7 numbered
				// items reads as a contradiction.
				<Text color="red">
					{`✗ ${failed} check(s) failed${
						warned > 0 ? `, ${warned} warning(s)` : ""
					}. Fix these before running \`codevhub install\`.`}
				</Text>
			)}
			{nextSteps.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>{"Next steps"}</Text>
					{nextSteps.map((line, i) => (
						<Text key={`next-${i.toString()}`} dimColor={line.startsWith("  ")}>
							{line}
						</Text>
					))}
				</Box>
			)}
			{/* Naming the file is the point of writing it — an artifact nobody
			    knows about cannot help a support conversation. Abbreviated to `~`
			    so it stays on one line: a path that wraps picks up the Step's
			    `│  ` gutter on continuation lines, which corrupts it when copied
			    (the same trap Login.tsx documents for the sign-in URL). */}
			{reportPath && (
				<Box marginTop={1}>
					<Text dimColor>
						{`Full report saved to ${abbreviateHome(reportPath)} — attach it to a support ticket.`}
					</Text>
				</Box>
			)}
		</Box>
	);
}
