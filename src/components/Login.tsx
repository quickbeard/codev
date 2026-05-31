import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuthData, login } from "@/lib/auth.js";
import { captureSkillhubSession } from "@/lib/skillhub.js";

interface LoginProps {
	onDone: (auth: AuthData) => void;
}

export function Login({ onDone }: LoginProps) {
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [waitingForEnter, setWaitingForEnter] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const openBrowserRef = useRef<(() => void) | null>(null);

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
		openBrowserRef.current = null;

		login(addLog, (openBrowserFn) => {
			openBrowserRef.current = openBrowserFn;
			setWaitingForEnter(true);
		})
			.then(async (auth) => {
				// Connect the SkillHub registry on the same login. Best-effort:
				// captureSkillhubSession never throws — it logs a warning and
				// returns — so a registry hiccup never blocks the SSO login that
				// already succeeded. It opens a second browser tab to the consent
				// page (the fresh SSO session means no re-login is needed).
				await captureSkillhubSession(addLog);
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
		if (waitingForEnter && key.return && openBrowserRef.current) {
			setWaitingForEnter(false);
			openBrowserRef.current();
			openBrowserRef.current = null;
			return;
		}
		if (error && key.return) {
			setAttempt((n) => n + 1);
		}
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
