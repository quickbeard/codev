import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { slugifyProviderName } from "@/lib/provider.js";

export interface ManualCredentialsValue {
	providerName: string;
	baseUrl: string;
	apiKey: string;
}

interface ManualCredentialsProps {
	onDone: (creds: ManualCredentialsValue) => void;
	readOnly?: boolean;
}

// The provider name is optional — an empty value means "use the default
// provider identity" and the caller resolves it (lib/provider.ts). The URL and
// key stay required.
const FIELDS = [
	{ key: "providerName" as const, label: "Provider Name", optional: true },
	{ key: "baseUrl" as const, label: "API URL", optional: false },
	{ key: "apiKey" as const, label: "API Key", optional: false },
];

const LABEL_WIDTH = Math.max(...FIELDS.map((f) => f.label.length));

type Values = Record<(typeof FIELDS)[number]["key"], string>;

export function ManualCredentials({
	onDone,
	readOnly = false,
}: ManualCredentialsProps) {
	const [values, setValues] = useState<Values>({
		providerName: "",
		baseUrl: "",
		apiKey: "",
	});
	const [index, setIndex] = useState(0);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useInput(
		(input, key) => {
			if (submitted) return;

			const current = FIELDS[index];
			if (!current) return;

			if (key.return) {
				const value = values[current.key].trim();
				if (!value && !current.optional) {
					setError(`${current.label} is required`);
					return;
				}
				setError(null);
				if (index < FIELDS.length - 1) {
					setIndex(index + 1);
					return;
				}
				setSubmitted(true);
				onDone({
					providerName: values.providerName.trim(),
					baseUrl: values.baseUrl.trim(),
					apiKey: values.apiKey.trim(),
				});
				return;
			}

			if (key.backspace || key.delete) {
				setValues((prev) => ({
					...prev,
					[current.key]: prev[current.key].slice(0, -1),
				}));
				return;
			}

			// Ignore other control keys (arrows, tab, escape, etc.) so they don't
			// leak raw escape sequences into the field.
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;

			// Strip newlines from pasted input; everything else (including spaces)
			// goes through so users can paste keys that contain unusual chars. The
			// provider name is the exception: it's the source of a config key, so
			// non-ASCII is dropped at the keystroke rather than mangled by the slug.
			const cleaned =
				current.key === "providerName"
					? input.replace(/[^\x20-\x7E]/g, "")
					: input.replace(/[\r\n]/g, "");
			if (!cleaned) return;

			setValues((prev) => ({
				...prev,
				[current.key]: prev[current.key] + cleaned,
			}));
		},
		{ isActive: !readOnly && !submitted },
	);

	const providerId = slugifyProviderName(values.providerName);

	return (
		<Box flexDirection="column">
			{FIELDS.map((field, i) => {
				const isActive = !readOnly && !submitted && i === index;
				const isPast = submitted || i < index;
				const value = values[field.key];
				const label = field.label.padEnd(LABEL_WIDTH, " ");
				return (
					<Box key={field.key} flexDirection="column">
						<Box>
							<Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
								{`${label}: `}
							</Text>
							<Text>{value}</Text>
							{isActive && <Text color="cyan">▌</Text>}
							{isPast && !value && <Text dimColor>(empty)</Text>}
						</Box>
						{field.key === "providerName" && providerId && (
							<Box>
								<Text
									dimColor
								>{`${" ".repeat(LABEL_WIDTH + 2)}→ id: ${providerId}`}</Text>
							</Box>
						)}
					</Box>
				);
			})}
			{error && !submitted && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}
			{!readOnly && !submitted && (
				<Box marginTop={1}>
					<Text dimColor>
						{"Press Enter to confirm each field (Provider Name is optional)."}
					</Text>
				</Box>
			)}
		</Box>
	);
}

export function manualCredentialsTitle() {
	return <Text bold>{"Enter API credentials"}</Text>;
}
