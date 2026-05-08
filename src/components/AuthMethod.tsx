import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type AuthMethodChoice = "existing" | "new" | "manual" | "skip";

interface Option {
	label: string;
	value: AuthMethodChoice;
}

const NEW_OPTION: Option = {
	label: "Get a new API Key",
	value: "new",
};
const MANUAL_OPTION: Option = {
	label: "I have my own API Key",
	value: "manual",
};
const EXISTING_OPTION: Option = {
	label: "Reuse existing API Key",
	value: "existing",
};
const SKIP_OPTION: Option = {
	label: "Skip configuration",
	value: "skip",
};

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
	const options: Option[] = hasExisting
		? [EXISTING_OPTION, NEW_OPTION, MANUAL_OPTION, SKIP_OPTION]
		: [NEW_OPTION, MANUAL_OPTION, SKIP_OPTION];
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

export function authMethodTitle(readOnly = false) {
	return (
		<Text bold>
			{"Choose authentication method "}
			{!readOnly && <Text dimColor>(↑/↓ to move, press Enter to confirm)</Text>}
		</Text>
	);
}
