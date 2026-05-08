import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import { type AuthData, saveApiKey } from "@/lib/auth.js";
import { fetchApiKey } from "@/lib/proxy.js";

interface FetchApiKeyProps {
	auth: AuthData;
	onDone: (apiKey: string) => void;
	onFallback: () => void;
}

export function FetchApiKey({ auth, onDone, onFallback }: FetchApiKeyProps) {
	const [pending, setPending] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [emptyCount, setEmptyCount] = useState(0);
	const [attempt, setAttempt] = useState(0);

	// `attempt` is the retry trigger — bumping it re-runs the effect.
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry trigger
	useEffect(() => {
		setError(null);
		setPending(true);

		fetchApiKey(auth.access_token)
			.then((key) => {
				setPending(false);
				if (!key) {
					setEmptyCount((n) => n + 1);
					return;
				}
				saveApiKey({ apiKey: key });
				onDone(key);
			})
			.catch((err: Error) => {
				setPending(false);
				setError(err.message);
			});
	}, [auth.access_token, onDone, attempt]);

	useInput((_input, key) => {
		if (pending) return;
		if (!key.return) return;
		if (error) {
			setAttempt((n) => n + 1);
			return;
		}
		if (emptyCount === 1) {
			setAttempt((n) => n + 1);
			return;
		}
		if (emptyCount >= 2) {
			onFallback();
		}
	});

	return (
		<Box flexDirection="column">
			{pending && (
				<Box>
					<Text color="cyan">
						<Spinner />
					</Text>
					<Text> Fetching API key from gateway...</Text>
				</Box>
			)}
			{error && (
				<>
					<Text color="red">{`Failed to fetch API key: ${error}`}</Text>
					<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
				</>
			)}
			{!pending && !error && emptyCount === 1 && (
				<>
					<Text color="yellow">{"Gateway returned an empty API key."}</Text>
					<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
				</>
			)}
			{!pending && !error && emptyCount >= 2 && (
				<>
					<Text color="yellow">
						{"Gateway returned an empty API key again."}
					</Text>
					<Text dimColor>
						{"Press Enter to enter credentials manually, Ctrl-C to quit"}
					</Text>
				</>
			)}
		</Box>
	);
}

export function fetchApiKeyTitle() {
	return <Text bold>{"Fetching new API Key"}</Text>;
}
