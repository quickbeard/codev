import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import { PasteBackPrompt, usePasteBack } from "@/components/PasteBack.js";
import { type AuthData, login } from "@/lib/auth.js";
import { clipboard } from "@/lib/clipboard.js";

interface LoginProps {
	onDone: (auth: AuthData) => void;
	// How long to wait, after the browser is auto-opened, before revealing the
	// manual sign-in fallback (URL + paste field). Most users finish in the
	// browser well before this fires and never see the fallback at all — it
	// only surfaces for headless/remote machines or a browser that didn't open.
	// Overridable so tests can reveal it immediately.
	fallbackDelayMs?: number;
}

export function Login({ onDone, fallbackDelayMs = 3000 }: LoginProps) {
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [authUrl, setAuthUrl] = useState<string | null>(null);
	// Revealed by a timer once the URL is ready (or kept hidden on the happy
	// path). Gates the whole manual fallback block — URL, copy hint, paste field.
	const [showFallback, setShowFallback] = useState(false);
	const [copied, setCopied] = useState(false);
	// Set once login() resolves. The parent advances but keeps this Step mounted
	// as read-only history, so without this the pre-URL / waiting spinner would
	// keep animating (and flickering) forever — and misleadingly say "Starting
	// sign-in..." after we're already done. `doneAuth` carries the resolved
	// identity so the completed frame shows a green "Signed in as <email>" line.
	const [completed, setCompleted] = useState(false);
	const [doneAuth, setDoneAuth] = useState<AuthData | null>(null);

	// The paste field goes live with the fallback. Until then keystrokes are
	// ignored, so the lone-"c" copy shortcut and the paste input never compete
	// with the spinner-only waiting state.
	const fallbackReady = authUrl !== null && showFallback && !error;
	const paste = usePasteBack(fallbackReady);

	const addLog = useCallback((msg: string) => {
		setLogs((prev) => [...prev, msg]);
	}, []);

	// `attempt` is the retry trigger — bumping it re-runs this effect so a
	// fresh login() kicks off. It's intentionally unread inside the body.
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry trigger
	useEffect(() => {
		setLogs([]);
		setError(null);
		setAuthUrl(null);
		setShowFallback(false);
		setCopied(false);
		setCompleted(false);
		setDoneAuth(null);
		paste.reset();

		login(addLog, (openBrowserFn, url, submitManualCode) => {
			paste.submitRef.current = submitManualCode;
			setAuthUrl(url);
			// Auto-open the browser the moment the URL is ready — no Enter gate.
			// On a headless box the open is a harmless no-op and the user waits
			// for the fallback to reveal the URL/paste field instead.
			openBrowserFn();
		})
			.then((auth) => {
				// Freeze the UI to a static "signed in" line before handing off, so
				// the kept-mounted Step stops spinning once we're done.
				setDoneAuth(auth);
				setCompleted(true);
				onDone(auth);
			})
			.catch((err: Error) => {
				// Node's built-in fetch throws `TypeError: fetch failed` for any
				// network-layer failure and stashes the real reason (DNS, TLS,
				// proxy interception, etc.) on `err.cause`. Surface it so users
				// can self-diagnose instead of staring at a bare "fetch failed".
				const cause = err.cause;
				const causeMsg =
					cause instanceof Error
						? cause.message
						: cause !== undefined
							? String(cause)
							: "";
				setError(causeMsg ? `${err.message} (${causeMsg})` : err.message);
			});
	}, [addLog, onDone, attempt]);

	// Reveal the manual fallback a few seconds after the URL is ready, so the
	// happy path stays a clean one-line spinner.
	useEffect(() => {
		if (authUrl === null || error) return;
		const timer = setTimeout(() => setShowFallback(true), fallbackDelayMs);
		return () => clearTimeout(timer);
	}, [authUrl, error, fallbackDelayMs]);

	// Pressing "c" while the fallback is up copies the sign-in URL to the
	// clipboard. We watch the paste field for a lone "c" (the same trick Claude
	// Code uses): a real pasted callback URL arrives as one long string and
	// never settles on a bare "c", so this can't swallow a genuine paste.
	useEffect(() => {
		if (!fallbackReady || authUrl === null) return;
		if (paste.pasteValue !== "c") return;
		clipboard.copy(authUrl);
		paste.clearValue();
		setCopied(true);
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [fallbackReady, authUrl, paste.pasteValue, paste.clearValue]);

	useInput((_input, key) => {
		// A fatal failure takes over the screen: Enter restarts the attempt.
		if (error && key.return) setAttempt((n) => n + 1);
	});

	if (error) {
		return (
			<Box flexDirection="column">
				<Text color="red">{`Login failed: ${error}`}</Text>
				<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
			</Box>
		);
	}

	// Login resolved: render a static green "Signed in as <email>" line (no
	// spinner, no transient log history). Covers the already-logged-in path
	// (onReady never fires, so authUrl stays null) and the normal success path
	// alike — in both, the parent keeps this Step mounted and a live spinner
	// would just churn. Every caller (install, config, standalone login) gets
	// this line for free instead of hand-rolling its own.
	if (completed) {
		return (
			<Text color="green">
				{`✓ Signed in${doneAuth ? ` as ${doneAuth.user.email}` : ""}`}
			</Text>
		);
	}

	// Pre-URL: cached-session resolves and transient status (e.g. "Already
	// logged in as…", "Refreshing session…") show here, then the component
	// hands off via onDone. Once the URL is ready we switch to the interactive
	// waiting UI and stop echoing login()'s internal log lines.
	if (authUrl === null) {
		return (
			<Box flexDirection="column">
				{logs.map((log, i) => (
					<Text key={`login-${i.toString()}`} dimColor>
						{log}
					</Text>
				))}
				<Box>
					<Text color="cyan">
						<Spinner />
					</Text>
					<Text>{" Starting sign-in..."}</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Box>
				{/* Animate only until the fallback (URL + paste field) appears.
				    Once the URL is on screen the user may be selecting it to copy,
				    and a ticking spinner redraws the whole frame ~12×/s — which
				    clears their terminal selection and reads as flicker. A static
				    marker keeps the frame stable so the URL stays selectable. */}
				{showFallback ? (
					<Text color="cyan">{"●"}</Text>
				) : (
					<Text color="cyan">
						<Spinner />
					</Text>
				)}
				<Text>{" Waiting for sign-in to complete in your browser..."}</Text>
			</Box>
			{showFallback && (
				<Box flexDirection="column" marginTop={1}>
					{/* Break the URL out to column 0. Negative margin cancels the
					    root padding(1) + the Step's borderLeft(1) + paddingLeft(2) = 4
					    columns. Left inside the Step's bordered box, a wrapped URL gets
					    a "│  " gutter redrawn on every continuation line, which is then
					    copied into the middle of the URL and corrupts it. Flush-left,
					    wrapped lines carry only a newline — which `new URL()` and browser
					    address bars both strip — so the copied URL stays intact. The
					    press-c-to-copy shortcut sidesteps manual selection entirely. */}
					<Box flexDirection="column" marginLeft={-4}>
						<Box>
							<Text dimColor>{"Browser didn't open? Sign in here "}</Text>
							{copied ? (
								<Text color="green">{"(copied!)"}</Text>
							) : (
								<Text dimColor>{"(press C to copy)"}</Text>
							)}
							<Text dimColor>{":"}</Text>
						</Box>
						<Text>{authUrl}</Text>
					</Box>
					<PasteBackPrompt
						pasteValue={paste.pasteValue}
						pasteError={paste.pasteError}
						submitting={paste.submitting}
						caption={
							<Text dimColor>
								{"After signing in, copy the code shown and paste it here:"}
							</Text>
						}
					/>
				</Box>
			)}
		</Box>
	);
}

export function loginTitle() {
	return <Text bold>{"Login"}</Text>;
}
