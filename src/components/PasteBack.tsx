import { Box, Text, useInput } from "ink";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useRef,
	useState,
} from "react";

// Shared no-browser paste-back affordance for the SSO login flow. A remote or
// headless user finishes login in a browser on another device and lands on the
// hosted success page, which shows their authorization code with a "Copy code"
// button; they paste that code here. (A full callback URL still works too —
// submitManualCode accepts either.) Both <Login> (install/config) and
// <UploadApp> (codevhub upload) drive the same auth.login() submitManualCode
// closure, so they share this hook and the matching <PasteBackPrompt> renderer.

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
	// Clears just the typed value + inline error, leaving the stashed submitter
	// and submitting flag intact. <Login> uses it to consume a lone "c"
	// keystroke (the copy-URL shortcut) without tearing down the paste flow.
	clearValue: () => void;
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

	const clearValue = useCallback(() => {
		setPasteValue("");
		setPasteError(null);
	}, []);

	useInput(
		(input, key) => {
			const submit = submitRef.current;
			if (!submit) return;
			if (key.return) {
				// Enter on an empty field is a no-op here; only a non-empty field
				// submits the pasted URL. Both <Login> and <UploadApp> auto-open the
				// browser without an Enter gate, so an empty-field Enter simply does
				// nothing.
				const value = pasteValue.trim();
				if (!value) return;
				const err = submit(value);
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

	return { pasteValue, pasteError, submitting, submitRef, reset, clearValue };
}

export function PasteBackPrompt({
	pasteValue,
	pasteError,
	submitting,
	caption,
}: Pick<PasteBack, "pasteValue" | "pasteError" | "submitting"> & {
	// Optional override for the lines above the input. <Login> passes a concise
	// one-liner; callers that omit it (e.g. <UploadApp>) get the original,
	// fuller explanation of why the localhost page can't load.
	caption?: ReactNode;
}) {
	return (
		<Box flexDirection="column" marginTop={1}>
			{caption ?? (
				<>
					<Text dimColor>
						{"After you sign in, the page shows an authorization code."}
					</Text>
					<Text dimColor>
						{'Use its "Copy code" button, then paste the code here:'}
					</Text>
				</>
			)}
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
