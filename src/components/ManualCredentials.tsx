import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { t } from "@/lib/i18n.js";
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
//
// The `key` and `optional` halves are static, but the labels are looked up per
// render: a module-level constant would freeze the English text at import time,
// before a test could switch locale.
const FIELDS = [
	{
		key: "providerName" as const,
		labelKey: "manual_creds.field.provider_name",
		optional: true,
	},
	{
		key: "baseUrl" as const,
		labelKey: "manual_creds.field.api_url",
		optional: false,
	},
	{
		key: "apiKey" as const,
		labelKey: "manual_creds.field.api_key",
		optional: false,
	},
] as const;

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
					setError(t("common.field_required", { field: t(current.labelKey) }));
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
	// Derived from the active locale's labels. Rendered as an Ink <Box width>
	// rather than String.padEnd so the gutter stays correct for scripts whose
	// characters are not one cell wide — Yoga measures display width, padEnd
	// counts UTF-16 code units.
	const labelWidth = Math.max(...FIELDS.map((f) => t(f.labelKey).length)) + 2;

	return (
		<Box flexDirection="column">
			{FIELDS.map((field, i) => {
				const isActive = !readOnly && !submitted && i === index;
				const isPast = submitted || i < index;
				const value = values[field.key];
				return (
					<Box key={field.key} flexDirection="column">
						<Box>
							<Box width={labelWidth} flexShrink={0}>
								<Text
									color={isActive ? "cyan" : undefined}
									dimColor={!isActive}
								>
									{`${t(field.labelKey)}: `}
								</Text>
							</Box>
							<Text>{value}</Text>
							{isActive && <Text color="cyan">▌</Text>}
							{isPast && !value && (
								<Text dimColor>{t("manual_creds.empty")}</Text>
							)}
						</Box>
						{field.key === "providerName" && providerId && (
							<Box>
								<Box width={labelWidth} flexShrink={0} />
								<Text dimColor>{`→ id: ${providerId}`}</Text>
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
					<Text dimColor>{t("manual_creds.hint")}</Text>
				</Box>
			)}
		</Box>
	);
}

export function manualCredentialsTitle() {
	return <Text bold>{t("manual_creds.title")}</Text>;
}
