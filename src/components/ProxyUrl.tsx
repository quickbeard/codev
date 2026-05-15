import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type ProxyUrlChoice = "default" | "custom";

interface ProxyUrlProps {
	onDone: (url: string | null) => void;
	readOnly?: boolean;
	selected?: ProxyUrlChoice | null;
}

interface Option {
	label: string;
	value: ProxyUrlChoice;
}

const OPTIONS: Option[] = [
	{ label: "Use default CoDev proxy URL", value: "default" },
	{ label: "Use my own proxy URL", value: "custom" },
];

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function validateUrl(input: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return "Enter a valid URL (including https://).";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return "URL must use http or https.";
	}
	return null;
}

export function ProxyUrl({
	onDone,
	readOnly = false,
	selected = null,
}: ProxyUrlProps) {
	const [phase, setPhase] = useState<"choose" | "input">("choose");
	const [cursor, setCursor] = useState(0);
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);

	useInput(
		(input, key) => {
			if (readOnly) return;

			if (phase === "choose") {
				if (key.upArrow) {
					setCursor((c) => Math.max(0, c - 1));
					return;
				}
				if (key.downArrow) {
					setCursor((c) => Math.min(OPTIONS.length - 1, c + 1));
					return;
				}
				if (key.return) {
					const option = OPTIONS[cursor];
					if (!option) return;
					if (option.value === "default") {
						onDone(null);
						return;
					}
					setPhase("input");
				}
				return;
			}

			// phase === "input"
			if (key.return) {
				const trimmed = value.trim();
				if (!trimmed) {
					setError("URL is required.");
					return;
				}
				const validationError = validateUrl(trimmed);
				if (validationError) {
					setError(validationError);
					return;
				}
				setError(null);
				onDone(stripTrailingSlashes(trimmed));
				return;
			}

			if (key.backspace || key.delete) {
				setValue((prev) => prev.slice(0, -1));
				return;
			}

			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;

			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;
			setValue((prev) => prev + cleaned);
		},
		{ isActive: !readOnly },
	);

	if (readOnly && selected) {
		return (
			<Box flexDirection="column">
				{OPTIONS.map((option) => {
					const isChosen = option.value === selected;
					return (
						<Box key={option.value}>
							<Text color={isChosen ? "green" : undefined}>
								{isChosen ? "●" : "○"}
							</Text>
							<Text> </Text>
							<Text dimColor={!isChosen}>{option.label}</Text>
						</Box>
					);
				})}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{OPTIONS.map((option, i) => {
				const isCursor = phase === "choose" && cursor === i && !readOnly;
				const isSelected = phase === "input" && option.value === "custom";
				return (
					<Box key={option.value}>
						<Text color={isSelected ? "green" : undefined}>
							{isSelected ? "●" : "○"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor && !isSelected}>
							{option.label}
						</Text>
					</Box>
				);
			})}
			{phase === "input" && (
				<Box marginTop={1} flexDirection="column">
					<Box>
						<Text color="cyan">{"Proxy URL: "}</Text>
						<Text>{value}</Text>
						{!readOnly && <Text color="cyan">▌</Text>}
					</Box>
					{error && (
						<Box marginTop={1}>
							<Text color="red">{error}</Text>
						</Box>
					)}
					{!readOnly && (
						<Box marginTop={1}>
							<Text dimColor>{"Press Enter to confirm."}</Text>
						</Box>
					)}
				</Box>
			)}
		</Box>
	);
}

export function proxyUrlTitle(readOnly = false) {
	return (
		<Text bold>
			{"Choose proxy URL "}
			{!readOnly && <Text dimColor>(↑/↓ to move, Enter to confirm)</Text>}
		</Text>
	);
}
