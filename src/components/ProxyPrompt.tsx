import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { normalizeProxyInput } from "@/lib/doctor.js";

interface ProxyPromptProps {
	/** Called with a normalized proxy URL, or null when the user skips. */
	onSubmit: (proxyUrl: string | null) => void;
	readOnly?: boolean;
}

/**
 * Single `host:port` field, offered when the network checks fail and no working
 * proxy is configured.
 *
 * Hand-rolled on `useInput` like ManualCredentials — the repo deliberately
 * carries no text-input dependency, and one optional field does not justify
 * adding one.
 */
export function ProxyPrompt({ onSubmit, readOnly = false }: ProxyPromptProps) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitted, setSubmitted] = useState(false);

	useInput(
		(input, key) => {
			if (submitted) return;

			if (key.return) {
				const trimmed = value.trim();
				// Blank means "skip" — the failure stays recorded and the summary
				// still prints the setup instructions.
				if (!trimmed) {
					setSubmitted(true);
					onSubmit(null);
					return;
				}
				const url = normalizeProxyInput(trimmed);
				if (!url) {
					setError(
						"That doesn't look like a proxy address. Use host:port, e.g. 10.0.0.1:8080",
					);
					return;
				}
				setError(null);
				setSubmitted(true);
				onSubmit(url);
				return;
			}

			if (key.backspace || key.delete) {
				setValue((prev) => prev.slice(0, -1));
				return;
			}

			// Ignore control keys so escape sequences never leak into the field.
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;
			setValue((prev) => prev + input);
		},
		{ isActive: !readOnly && !submitted },
	);

	if (submitted) {
		return (
			<Text dimColor>
				{value.trim() ? `Retrying via ${value.trim()}…` : "Skipped."}
			</Text>
		);
	}

	return (
		<Box flexDirection="column">
			<Text>
				{
					"The network checks failed. If this machine reaches the internet through a proxy, enter it here and CoDev will re-run the checks with it applied."
				}
			</Text>
			<Text dimColor>
				{"Nothing is written to disk — this applies to this run only."}
			</Text>
			<Box marginTop={1}>
				<Text>{"Proxy (host:port), or Enter to skip: "}</Text>
				<Text color="cyan">{value}</Text>
				<Text color="cyan">▌</Text>
			</Box>
			{error && <Text color="red">{error}</Text>}
		</Box>
	);
}

export function proxyPromptTitle() {
	return <Text bold>{"Configure a proxy"}</Text>;
}
