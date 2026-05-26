import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { fetchModels } from "@/lib/proxy.js";

interface ModelSelectProps {
	apiKey: string;
	baseUrl?: string;
	// The picked id becomes the default; the full list is passed alongside so
	// the caller can register every model with the AI tool that supports a
	// model list (today, OpenCode).
	onSelect: (model: string, models: string[]) => void;
	onError: (err: Error) => void;
	readOnly?: boolean;
	selected?: string | null;
}

type Phase = "loading" | "ready" | "errored";

export function ModelSelect({
	apiKey,
	baseUrl,
	onSelect,
	onError,
	readOnly = false,
	selected = null,
}: ModelSelectProps) {
	const [phase, setPhase] = useState<Phase>("loading");
	const [models, setModels] = useState<string[]>([]);
	const [cursor, setCursor] = useState(0);
	const errorReported = useRef(false);

	useEffect(() => {
		let cancelled = false;
		fetchModels(apiKey, baseUrl)
			.then((ids) => {
				if (cancelled) return;
				setModels(ids);
				setPhase("ready");
			})
			.catch((err: Error) => {
				if (cancelled) return;
				setPhase("errored");
				if (!errorReported.current) {
					errorReported.current = true;
					onError(err);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [apiKey, baseUrl, onError]);

	useInput(
		(_input, key) => {
			if (phase !== "ready") return;
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(models.length - 1, c + 1));
			} else if (key.return) {
				const choice = models[cursor];
				if (choice) onSelect(choice, models);
			}
		},
		{ isActive: !readOnly && phase === "ready" },
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
		// Parent renders the failure step; nothing to show here.
		return null;
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
