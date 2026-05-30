import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type ProxyUrlChoice =
	| { method: "default" }
	| { method: "custom"; url: string };

interface ProxyUrlProps {
	onConfirm: (choice: ProxyUrlChoice) => void;
	readOnly?: boolean;
	selected?: ProxyUrlChoice | null;
}

interface Option {
	label: string;
	value: "default" | "custom";
}

const OPTIONS: Option[] = [
	{ label: "Use the default proxy URL", value: "default" },
	{ label: "Enter a custom proxy URL", value: "custom" },
];

// Accept http(s) URLs only. The URL constructor rejects malformed input;
// the protocol check rules out things like `ftp://` or `file://` that would
// parse but make no sense as a proxy endpoint.
function validateProxyUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return "URL is required";
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return "Invalid URL";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return "URL must start with http:// or https://";
	}
	if (!parsed.hostname) return "URL must include a host";
	return null;
}

export function ProxyUrl({
	onConfirm,
	readOnly = false,
	selected = null,
}: ProxyUrlProps) {
	const [cursor, setCursor] = useState(0);
	const [phase, setPhase] = useState<"choose" | "input">("choose");
	const [url, setUrl] = useState("");
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
						onConfirm({ method: "default" });
						return;
					}
					setPhase("input");
				}
				return;
			}
			// phase === "input"
			if (key.return) {
				const err = validateProxyUrl(url);
				if (err) {
					setError(err);
					return;
				}
				setError(null);
				onConfirm({ method: "custom", url: url.trim() });
				return;
			}
			if (key.backspace || key.delete) {
				setUrl((prev) => prev.slice(0, -1));
				return;
			}
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;
			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;
			setUrl((prev) => prev + cleaned);
		},
		{ isActive: !readOnly },
	);

	if (readOnly && selected) {
		return (
			<Box flexDirection="column">
				{OPTIONS.map((option) => {
					const isChosen = selected.method === option.value;
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
				{selected.method === "custom" && (
					<Box marginTop={1}>
						<Text dimColor>URL: </Text>
						<Text>{selected.url}</Text>
					</Box>
				)}
			</Box>
		);
	}

	if (phase === "choose") {
		return (
			<Box flexDirection="column">
				{OPTIONS.map((option, i) => {
					const isCursor = cursor === i;
					return (
						<Box key={option.value}>
							<Text>{isCursor ? "○" : "○"}</Text>
							<Text> </Text>
							<Text bold={isCursor} dimColor={!isCursor}>
								{option.label}
							</Text>
						</Box>
					);
				})}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Box>
				<Text color="cyan">URL: </Text>
				<Text>{url}</Text>
				<Text color="cyan">▌</Text>
			</Box>
			{error && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<Text dimColor>Press Enter to confirm.</Text>
			</Box>
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
