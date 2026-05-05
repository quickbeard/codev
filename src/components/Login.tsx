import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { login } from "@/auth.js";

interface LoginProps {
	onDone: (apiKey: string) => void;
	onFallback: () => void;
}

export function Login({ onDone, onFallback: _onFallback }: LoginProps) {
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
		// Reset per-attempt UI state so a retry doesn't leave stale logs or
		// a lingering "Press Enter" prompt visible while the new flow runs.
		setLogs([]);
		setError(null);
		setWaitingForEnter(false);
		openBrowserRef.current = null;

		login(addLog, (openBrowserFn) => {
			openBrowserRef.current = openBrowserFn;
			setWaitingForEnter(true);
		})
			.then((auth) => {
				onDone(auth.access_token);
			})
			.catch((err: Error) => {
				setError(err.message);
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
	return <Text bold>{"Login to SSO"}</Text>;
}
