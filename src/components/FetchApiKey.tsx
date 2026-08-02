import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import type { AuthData } from "@/lib/auth.js";
import { fetchApiKey } from "@/lib/backend.js";
import { BACKEND_URL } from "@/lib/const.js";
import { describeFailure } from "@/lib/doctor.js";
import { t } from "@/lib/i18n.js";

interface FetchApiKeyProps {
	auth: AuthData;
	onDone: (apiKey: string) => void;
	onFallback: () => void;
}

// Persisting the key is the caller's responsibility — only the caller knows
// what shape the full credential tuple (apiKey + baseUrl + model) should take
// at this moment. A previous version called saveApiKey({apiKey}) here, which
// clobbered base_url/model on disk and forced every caller to immediately
// re-save with the preserved fields.
export function FetchApiKey({ auth, onDone, onFallback }: FetchApiKeyProps) {
	const [pending, setPending] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [emptyCount, setEmptyCount] = useState(0);
	const [succeeded, setSucceeded] = useState(false);
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
				setSucceeded(true);
				onDone(key);
			})
			.catch((err: Error) => {
				setPending(false);
				// A transport failure here (proxy/TLS/DNS) gets the full diagnosis;
				// a backend HTTP error keeps its own already-precise message.
				setError(
					describeFailure(err, {
						url: `${BACKEND_URL}/auth/exchange`,
						method: "POST",
					}),
				);
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
					<Text>{` ${t("fetch_key.pending")}`}</Text>
				</Box>
			)}
			{succeeded && <Text color="green">{t("fetch_key.success")}</Text>}
			{error && (
				<>
					{/* One-line reasons stay inline; a multi-line transport
					    diagnosis keeps its structure on following lines. */}
					<Text color="red">
						{t("fetch_key.failed", { reason: error.split("\n")[0] ?? "" })}
					</Text>
					{error
						.split("\n")
						.slice(1)
						.map((line, i) => (
							<Text key={`key-err-${i.toString()}`} color="red">
								{line}
							</Text>
						))}
					<Text dimColor>{t("common.retry_hint")}</Text>
				</>
			)}
			{!pending && !error && emptyCount === 1 && (
				<>
					<Text color="yellow">{t("fetch_key.empty")}</Text>
					<Text dimColor>{t("common.retry_hint")}</Text>
				</>
			)}
			{!pending && !error && emptyCount >= 2 && (
				<>
					<Text color="yellow">{t("fetch_key.empty_again")}</Text>
					<Text dimColor>{t("fetch_key.manual_hint")}</Text>
				</>
			)}
		</Box>
	);
}

export function fetchApiKeyTitle() {
	return <Text bold>{t("fetch_key.title")}</Text>;
}
