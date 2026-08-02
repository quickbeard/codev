import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { t } from "@/lib/i18n.js";

interface YesNoProps {
	defaultAnswer: "yes" | "no";
	onAnswer: (proceed: boolean) => void;
	readOnly?: boolean;
	/** Defaults to the localized "Continue?" when omitted. */
	promptText?: string;
}

// Apt-style yes/no prompt: line-based (need Enter to submit), defaultAnswer
// controls the [Y/n] vs [y/N] label and what an empty Enter means.
// `y`/`Y` (or any buffer starting with y/Y) → proceed; anything else → abort.
export function YesNo({
	defaultAnswer,
	onAnswer,
	readOnly = false,
	promptText,
}: YesNoProps) {
	const [buffer, setBuffer] = useState("");
	const [submitted, setSubmitted] = useState(false);

	useInput(
		(input, key) => {
			if (submitted) return;

			// Check if this chunk contains Enter. Real TTYs may flush typed
			// characters and \r together as a single chunk (e.g. "y\r"), in
			// which case Ink does not set key.return — detect the newline byte
			// in `input` directly and treat anything before it as buffer.
			const newlineIdx = input.search(/[\r\n]/);
			if (key.return || newlineIdx >= 0) {
				const prefix = newlineIdx >= 0 ? input.slice(0, newlineIdx) : "";
				const finalBuffer = (buffer + prefix).trim();
				setSubmitted(true);
				if (finalBuffer === "") {
					onAnswer(defaultAnswer === "yes");
					return;
				}
				onAnswer(finalBuffer[0]?.toLowerCase() === "y");
				return;
			}

			if (key.backspace || key.delete) {
				setBuffer((prev) => prev.slice(0, -1));
				return;
			}

			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;

			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;
			setBuffer((prev) => prev + cleaned);
		},
		{ isActive: !readOnly && !submitted },
	);

	// The [Y/n] letters are the keys the user actually types and are matched
	// against "y" below, so they stay untranslated in every locale.
	const label = defaultAnswer === "yes" ? "[Y/n]" : "[y/N]";
	const prompt = promptText ?? t("common.continue_question");

	return (
		<Box>
			<Text color="cyan">{`${prompt} ${label} `}</Text>
			<Text>{buffer}</Text>
			{!readOnly && !submitted && <Text color="cyan">▌</Text>}
		</Box>
	);
}
