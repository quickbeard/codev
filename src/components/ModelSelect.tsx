import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { fetchModels, isInvalidKeyError } from "@/lib/proxy.js";

interface ModelSelectProps {
	apiKey: string;
	baseUrl?: string;
	// The picked id becomes the default; the full list is passed alongside so
	// the caller can register every model with the AI tool that supports a
	// model list (today, OpenCode).
	onSelect: (model: string, models: string[]) => void;
	// Optional. Fires once per failed fetch attempt so parents can route on
	// auth errors (e.g. ModelApp's invalid-key → re-auth flow). Parents that
	// don't navigate away can omit this — ModelSelect renders its own error
	// frame + retry prompt regardless.
	onError?: (err: Error) => void;
	// When set, a non-auth fetch failure (network / gateway 5xx / timeout /
	// empty list) is treated as recoverable: instead of the errored-with-retry
	// frame, ModelSelect auto-selects this model (via onSelect) so the flow can
	// proceed. Auth failures (401/403) still go through onError untouched, so
	// callers like ModelApp can re-authenticate — a fallback model is useless
	// with a rejected key. Omit to keep retry-on-every-failure.
	fallbackModel?: string;
	// Fires once when ModelSelect falls back to `fallbackModel`. Parents use it
	// to render a persistent warning; the model itself arrives via onSelect.
	onFallback?: (err: Error) => void;
	readOnly?: boolean;
	selected?: string | null;
}

type Phase = "loading" | "ready" | "errored" | "fallback";

export function ModelSelect({
	apiKey,
	baseUrl,
	onSelect,
	onError,
	fallbackModel,
	onFallback,
	readOnly = false,
	selected = null,
}: ModelSelectProps) {
	const [phase, setPhase] = useState<Phase>("loading");
	const [models, setModels] = useState<string[]>([]);
	const [cursor, setCursor] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const errorReported = useRef(false);

	// `attempt` is the retry trigger — bumping it re-runs the effect with a
	// fresh `cancelled` closure and a reset `errorReported` so the next
	// failure can fire `onError` again (parents like ModelApp need to know
	// about a follow-up auth error after a transient retry).
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry trigger
	useEffect(() => {
		let cancelled = false;
		errorReported.current = false;
		setPhase("loading");
		setError(null);
		fetchModels(apiKey, baseUrl)
			.then((ids) => {
				if (cancelled) return;
				setModels(ids);
				setPhase("ready");
			})
			.catch((err: Error) => {
				if (cancelled) return;
				// Recoverable failure with a fallback configured: warn once, then
				// auto-select the fallback so the flow proceeds. Auth failures
				// (401/403) skip this and fall through to the errored/onError path
				// so callers can re-authenticate instead of papering over a bad key.
				if (fallbackModel && !isInvalidKeyError(err)) {
					setModels([fallbackModel]);
					setError(err.message);
					setPhase("fallback");
					if (!errorReported.current) {
						errorReported.current = true;
						onFallback?.(err);
					}
					onSelect(fallbackModel, [fallbackModel]);
					return;
				}
				setPhase("errored");
				setError(err.message);
				if (!errorReported.current) {
					errorReported.current = true;
					onError?.(err);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [apiKey, baseUrl, onError, attempt]);

	useInput(
		(_input, key) => {
			if (phase === "ready" && !readOnly) {
				if (key.upArrow) {
					setCursor((c) => Math.max(0, c - 1));
				} else if (key.downArrow) {
					setCursor((c) => Math.min(models.length - 1, c + 1));
				} else if (key.return) {
					const choice = models[cursor];
					if (choice) onSelect(choice, models);
				}
				return;
			}
			if (phase === "errored" && !readOnly && key.return) {
				setAttempt((n) => n + 1);
			}
		},
		{ isActive: !readOnly && (phase === "ready" || phase === "errored") },
	);

	if (phase === "loading") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner />
				</Text>
				<Text> Fetching available models...</Text>
			</Box>
		);
	}

	if (phase === "errored") {
		return (
			<Box flexDirection="column">
				<Text color="red">{`Failed to fetch models: ${error ?? "unknown error"}`}</Text>
				<Text dimColor>{"Press Enter to retry, Ctrl-C to quit"}</Text>
			</Box>
		);
	}

	if (phase === "fallback") {
		// The fallback model has already been handed to onSelect; the parent
		// renders the explanatory warning. Show the model as the selected row so
		// it reads consistently in the (read-only) step history.
		return (
			<Box flexDirection="column">
				{models.map((id) => (
					<Box key={id}>
						<Text color="green">●</Text>
						<Text> </Text>
						<Text>{id}</Text>
					</Box>
				))}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{models.map((id, i) => {
				const isChosen = selected === id;
				const isCursor = !readOnly && cursor === i;
				return (
					<Box key={id}>
						<Text color={isChosen ? "green" : undefined}>
							{isChosen ? "●" : "○"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor && !isChosen}>
							{id}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function modelSelectTitle(readOnly = false) {
	return (
		<Text bold>
			{"Choose default model "}
			{!readOnly && <Text dimColor>(↑/↓ to move, Enter to confirm)</Text>}
		</Text>
	);
}
