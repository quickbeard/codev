import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { t } from "@/lib/i18n.js";

export type AuthMethodChoice = "existing" | "new" | "manual" | "skip";

interface Option {
	label: string;
	value: AuthMethodChoice;
}

// Built per render rather than held in module-level constants. A `const` here
// would resolve its label at import time, which is correct in production (the
// locale comes from the environment and never changes mid-process) but freezes
// the English text before a test can call resetLocaleCache().
function authOptions(hasExisting: boolean): Option[] {
	const options: Option[] = [
		{ label: t("auth_method.new"), value: "new" },
		{ label: t("auth_method.manual"), value: "manual" },
		{ label: t("auth_method.skip"), value: "skip" },
	];
	if (!hasExisting) return options;
	return [{ label: t("auth_method.existing"), value: "existing" }, ...options];
}

interface AuthMethodProps {
	onSelect: (choice: AuthMethodChoice) => void;
	readOnly?: boolean;
	selected?: AuthMethodChoice | null;
	hasExisting?: boolean;
}

export function AuthMethod({
	onSelect,
	readOnly = false,
	selected = null,
	hasExisting = false,
}: AuthMethodProps) {
	const options = authOptions(hasExisting);
	const [cursor, setCursor] = useState(0);

	useInput(
		(_input, key) => {
			if (key.upArrow) {
				setCursor((c) => Math.max(0, c - 1));
			} else if (key.downArrow) {
				setCursor((c) => Math.min(options.length - 1, c + 1));
			} else if (key.return) {
				const option = options[cursor];
				if (option) onSelect(option.value);
			}
		},
		{ isActive: !readOnly },
	);

	return (
		<Box flexDirection="column">
			{options.map((option, i) => {
				const isChosen = selected === option.value;
				const isCursor = !readOnly && cursor === i;
				return (
					<Box key={option.value}>
						<Text color={isChosen ? "green" : undefined}>
							{isChosen ? "●" : isCursor ? "○" : "○"}
						</Text>
						<Text> </Text>
						<Text bold={isCursor} dimColor={!isCursor && !isChosen}>
							{option.label}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}

export function configurationMethodTitle(readOnly = false) {
	return (
		<Text bold>
			{`${t("auth_method.title")} `}
			{!readOnly && <Text dimColor>{t("common.hint.move_confirm")}</Text>}
		</Text>
	);
}
