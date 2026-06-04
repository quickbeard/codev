import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
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
	const [pasteValue, setPasteValue] = useState("");
	const [pasteError, setPasteError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const openBrowserRef = useRef<(() => void) | null>(null);
	const submitManualCodeRef = useRef<
		((pasted: string) => string | null) | null
	>(null);

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
		setPasteValue("");
		setPasteError(null);
		setSubmitting(false);
		openBrowserRef.current = null;
		submitManualCodeRef.current = null;

		login(addLog, (openBrowserFn, url, submitManualCode) => {
			openBrowserRef.current = openBrowserFn;
			submitManualCodeRef.current = submitManualCode;
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
				setSubmitting(false);
				setError(causeMsg ? `${err.message} (${causeMsg})` : err.message);
			});
	}, [addLog, onDone, attempt]);

	useInput((input, key) => {
		// A fatal failure takes over the screen: Enter restarts the attempt.
		if (error) {
			if (key.return) setAttempt((n) => n + 1);
			return;
		}
		// First Enter opens the browser (and reveals the URL + paste field for a
		// no-browser user).
		if (waitingForEnter && key.return && openBrowserRef.current) {
			setWaitingForEnter(false);
			setBrowserOpened(true);
			openBrowserRef.current();
			openBrowserRef.current = null;
			return;
		}
		// The manual paste-back field, live once the browser step is done. Mirrors
		// the char-accumulation idiom in ManualCredentials/ProxyUrl.
		if (!browserOpened || submitting || !submitManualCodeRef.current) return;
		if (key.return) {
			const err = submitManualCodeRef.current(pasteValue.trim());
			if (err) {
				setPasteError(err);
			} else {
				setPasteError(null);
				setSubmitting(true);
			}
			return;
		}
		if (key.backspace || key.delete) {
			setPasteValue((prev) => prev.slice(0, -1));
			setPasteError(null);
			return;
		}
		if (key.ctrl || key.meta || key.escape) return;
		if (!input) return;
		// A pasted callback URL has no internal newlines; strip any trailing one
		// so it doesn't sneak into the value.
		const cleaned = input.replace(/[\r\n]/g, "");
		if (!cleaned) return;
		setPasteValue((prev) => prev + cleaned);
		setPasteError(null);
	});

	return (
		<Box flexDirection="column">
			{logs.map((log, i) => (
				<Text key={`login-${i.toString()}`}>{log}</Text>
			))}
			{waitingForEnter && (
				<Text color="cyan">
					{"Press Enter to open the browser and login..."}
				</Text>
			)}
			{browserOpened && !error && (
				<Box flexDirection="column" marginTop={1}>
					{authUrl && (
						<Box flexDirection="column">
							<Text dimColor>
								{"If the browser didn't open, visit this URL manually:"}
							</Text>
							<Text>{authUrl}</Text>
						</Box>
					)}
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>
							{
								"On a remote or headless machine? After you sign in, the browser"
							}
						</Text>
						<Text dimColor>
							{
								"can't load the localhost page it lands on — paste that page's full"
							}
						</Text>
						<Text dimColor>{"URL (or just the code) here:"}</Text>
						<Box>
							<Text color="cyan">{"> "}</Text>
							<Text>{pasteValue}</Text>
							{!submitting && <Text color="cyan">▌</Text>}
						</Box>
						{pasteError && <Text color="red">{pasteError}</Text>}
						<Text dimColor>
							{submitting ? "Completing sign-in..." : "Press Enter to submit."}
						</Text>
					</Box>
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
