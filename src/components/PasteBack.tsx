import { Box, Text, useInput } from "ink";
import { type RefObject, useCallback, useRef, useState } from "react";

// Shared no-browser paste-back affordance for the SSO login flow. A remote or
// headless user finishes login in a browser on another device, then copies the
// dead loopback callback URL (or just the code) from the address bar — the one
// their browser couldn't load because it points at this machine's localhost —
// and pastes it here. Both <Login> (install/config) and <UploadApp> (codev
// upload) drive the same auth.login() submitManualCode closure, so they share
// this hook and the matching <PasteBackPrompt> renderer to stay identical.

export interface PasteBack {
	pasteValue: string;
	pasteError: string | null;
	submitting: boolean;
	// auth.login() hands the caller its submitManualCode closure asynchronously
	// (via onReady), so callers stash it here once it arrives. null until then;
	// keystrokes are ignored while it's unset.
	submitRef: RefObject<((pasted: string) => string | null) | null>;
	// Clears the field, error, submitting flag, and stashed submitter — for
	// callers that re-run login() on retry (e.g. <Login>'s attempt bump).
	reset: () => void;
}

// `active` gates the keystroke listener: pass the caller's "the paste field is
// on screen" condition (browser opened, no fatal error, login still pending).
// The hook additionally suspends input while a submitted paste is completing,
// so the two never need to be combined at the call site.
export function usePasteBack(active: boolean): PasteBack {
	const [pasteValue, setPasteValue] = useState("");
	const [pasteError, setPasteError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const submitRef = useRef<((pasted: string) => string | null) | null>(null);

	const reset = useCallback(() => {
		setPasteValue("");
		setPasteError(null);
		setSubmitting(false);
		submitRef.current = null;
	}, []);

	useInput(
		(input, key) => {
			const submit = submitRef.current;
			if (!submit) return;
			if (key.return) {
				const err = submit(pasteValue.trim());
				if (err) {
					setPasteError(err);
				} else {
					setPasteError(null);
					setSubmitting(true);
				}
				return;
			}
			if (key.backspace || key.delete) {
				setPasteValue((prev) => prev.slice(0, -1));
				setPasteError(null);
				return;
			}
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;
			// A pasted callback URL has no internal newlines; strip any trailing one
			// so it doesn't sneak into the value.
			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;
			setPasteValue((prev) => prev + cleaned);
			setPasteError(null);
		},
		{ isActive: active && !submitting },
	);

	return { pasteValue, pasteError, submitting, submitRef, reset };
}

export function PasteBackPrompt({
	pasteValue,
	pasteError,
	submitting,
}: Pick<PasteBack, "pasteValue" | "pasteError" | "submitting">) {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text dimColor>
				{"On a remote or headless machine? After you sign in, the browser"}
			</Text>
			<Text dimColor>
				{"can't load the localhost page it lands on — paste that page's full"}
			</Text>
			<Text dimColor>{"URL (or just the code) here:"}</Text>
			<Box>
				<Text color="cyan">{"> "}</Text>
				<Text>{pasteValue}</Text>
				{!submitting && <Text color="cyan">▌</Text>}
			</Box>
			{pasteError && <Text color="red">{pasteError}</Text>}
			<Text dimColor>
				{submitting ? "Completing sign-in..." : "Press Enter to submit."}
			</Text>
		</Box>
	);
}
