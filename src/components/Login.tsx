import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { PasteBackPrompt, usePasteBack } from "@/components/PasteBack.js";
import { type AuthData, login } from "@/lib/auth.js";

interface LoginProps {
	onDone: (auth: AuthData) => void;
}

export function Login({ onDone }: LoginProps) {
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [waitingForEnter, setWaitingForEnter] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [authUrl, setAuthUrl] = useState<string | null>(null);
	const [browserOpened, setBrowserOpened] = useState(false);
	const openBrowserRef = useRef<(() => void) | null>(null);

	// The URL and paste-back field go live as soon as login() hands us the
	// authorize URL (waitingForEnter) — not only after the browser step — so a
	// no-browser user can copy the URL and paste their callback back without
	// first pressing Enter into a browser that will never open. The field stays
	// live through browserOpened; a fatal error takes over the screen and ends it.
	const urlReady = (waitingForEnter || browserOpened) && !error;
	const paste = usePasteBack(urlReady);

	const addLog = useCallback((msg: string) => {
		setLogs((prev) => [...prev, msg]);
	}, []);

	// `attempt` is the retry trigger — bumping it re-runs this effect so a
	// fresh login() kicks off. It's intentionally unread inside the body.
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry trigger
	useEffect(() => {
		setLogs([]);
		setError(null);
		setWaitingForEnter(false);
		setAuthUrl(null);
		setBrowserOpened(false);
		openBrowserRef.current = null;
		paste.reset();

		login(addLog, (openBrowserFn, url, submitManualCode) => {
			openBrowserRef.current = openBrowserFn;
			paste.submitRef.current = submitManualCode;
			setAuthUrl(url);
			setWaitingForEnter(true);
		})
			.then((auth) => {
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

	useInput((_input, key) => {
		// A fatal failure takes over the screen: Enter restarts the attempt.
		if (error) {
			if (key.return) setAttempt((n) => n + 1);
			return;
		}
		// Enter on an empty paste field opens the browser. A non-empty field means
		// the user is pasting a callback URL back by hand, so that Enter belongs to
		// usePasteBack's submit (which only fires on a non-empty field) and we leave
		// the browser closed.
		if (
			waitingForEnter &&
			key.return &&
			openBrowserRef.current &&
			!paste.pasteValue.trim()
		) {
			setWaitingForEnter(false);
			setBrowserOpened(true);
			openBrowserRef.current();
			openBrowserRef.current = null;
		}
	});

	return (
		<Box flexDirection="column">
			{logs.map((log, i) => (
				<Text key={`login-${i.toString()}`}>{log}</Text>
			))}
			{waitingForEnter && (
				<Text color="cyan">
					{
						"Press Enter to open the browser and login (or paste your callback URL below to sign in without one)..."
					}
				</Text>
			)}
			{urlReady && (
				<Box flexDirection="column" marginTop={1}>
					{authUrl && (
						// Break the URL out to column 0. Negative margin cancels the
						// root padding(1) + the Step's borderLeft(1) + paddingLeft(2) = 4
						// columns. Left inside the Step's bordered box, a wrapped URL gets
						// a "│  " gutter redrawn on every continuation line, which is then
						// copied into the middle of the URL and corrupts it. Flush-left,
						// wrapped lines carry only a newline — which `new URL()` and browser
						// address bars both strip — so the copied URL stays intact.
						<Box flexDirection="column" marginLeft={-4}>
							<Text dimColor>
								{
									"If the browser didn't open, copy this URL to sign in (here or on another device):"
								}
							</Text>
							<Text>{authUrl}</Text>
						</Box>
					)}
					<PasteBackPrompt
						pasteValue={paste.pasteValue}
						pasteError={paste.pasteError}
						submitting={paste.submitting}
					/>
				</Box>
			)}
			{error && (
				<>
					<Text color="red">{`Login failed: ${error}`}</Text>
					<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
				</>
			)}
		</Box>
	);
}

export function loginTitle() {
	return <Text bold>{"Login"}</Text>;
}
