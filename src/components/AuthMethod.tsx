import { Box, Text, useInput } from "ink";
import { useState } from "react";

export type AuthMethodChoice = "existing" | "sso" | "manual";

interface Option {
	label: string;
	value: AuthMethodChoice;
}

const SSO_OPTION: Option = {
	label: "Login to SSO to get new API Key",
	value: "sso",
};
const MANUAL_OPTION: Option = {
	label: "I have my own API Key",
	value: "manual",
};
const EXISTING_OPTION: Option = {
	label: "Use saved API Key",
	value: "existing",
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
		? [EXISTING_OPTION, SSO_OPTION, MANUAL_OPTION]
		: [SSO_OPTION, MANUAL_OPTION];
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
