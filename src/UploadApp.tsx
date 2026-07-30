import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { PasteBackPrompt, usePasteBack } from "@/components/PasteBack.js";
import { useCanType } from "@/components/useCanType.js";
import { runUpload, type UploadSummary } from "@/lib/upload.js";

type Phase = "running" | "done" | "error";

export function UploadApp({ force = false }: { force?: boolean }) {
	const { exit } = useApp();
	const canType = useCanType();
	const [phase, setPhase] = useState<Phase>("running");
	const [status, setStatus] = useState("Uploading logs...");
	const [loginUrl, setLoginUrl] = useState<string | null>(null);
	const [summary, setSummary] = useState<UploadSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	// The manual paste-back field is live only while a fresh interactive SSO
	// login is pending (loginUrl set). Mirrors the field in <Login> for
	// no-browser users.
	const paste = usePasteBack(phase === "running" && loginUrl !== null);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runUpload({
			force,
			onStatus: setStatus,
			onLoginUrl: setLoginUrl,
			onManualSubmit: (submit) => {
				paste.submitRef.current = submit;
			},
			// Login finished — drop the URL + paste-back prompt so they don't
			// linger below the spinner while the upload runs (the browser-callback
			// path never sets `submitting`, which is what otherwise hides them).
			onLoginDone: () => setLoginUrl(null),
		})
			.then((result) => {
				setSummary(result);
				setPhase("done");
			})
			.catch((err) => {
				setError(String(err));
				setPhase("error");
			});
	}, [paste.submitRef, force]);

	useEffect(() => {
		if (phase === "done" || phase === "error") {
			exit();
		}
	}, [phase, exit]);

	if (phase === "running") {
		return (
			<Box flexDirection="column">
				<Box>
					<Text color="cyan">
						<Spinner />
					</Text>
					<Text> {status}</Text>
				</Box>
				{loginUrl && !paste.submitting && (
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>
							{"If the browser didn't open, visit this URL manually:"}
						</Text>
						<Text>{loginUrl}</Text>
						{/* Without raw mode the hook ignores keystrokes (lib/tty.ts), so
						    the field would be inert. The URL above still completes sign-in
						    through the browser's loopback callback. */}
						{canType ? (
							<PasteBackPrompt
								pasteValue={paste.pasteValue}
								pasteError={paste.pasteError}
								submitting={paste.submitting}
							/>
						) : (
							<Text dimColor>
								{
									"This terminal can't accept keyboard input — finish sign-in in the browser."
								}
							</Text>
						)}
					</Box>
				)}
			</Box>
		);
	}

	if (phase === "error") {
		return (
			<Box flexDirection="column">
				<Text color="red">✗ Upload failed</Text>
				<Text dimColor>{error ?? "unknown error"}</Text>
			</Box>
		);
	}

	if (!summary) return null;
	// Nothing was found to upload. A bare "Uploaded 0/0" reads as a failure and
	// hides the most common cause — the agent was launched from a different
	// directory, or a tool codev doesn't read. Show exactly where we looked.
	if (summary.found === 0) {
		const targets = summary.targets ?? [];
		return (
			<Box flexDirection="column">
				<Text color="yellow">No conversations found for this project.</Text>
				{targets.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>codevhub looked in:</Text>
						{targets.map((t) => (
							<Text key={t.agent} dimColor>
								{"  • "}
								{t.agent}: {t.path}
							</Text>
						))}
					</Box>
				)}
				<Box marginTop={1}>
					<Text dimColor>
						If you used an AI agent here, make sure you launched it from this
						directory.
					</Text>
				</Box>
			</Box>
		);
	}
	return (
		<Box flexDirection="column">
			<Text color={summary.failed > 0 ? "yellow" : "green"}>
				✓ Uploaded {summary.uploaded}/{summary.found} conversation logs
			</Text>
			<Text dimColor>Skipped {summary.skipped} unchanged logs</Text>
			{summary.failed > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="red">Failed {summary.failed} logs:</Text>
					{summary.errors.slice(0, 5).map((err) => (
						<Text key={err.file} dimColor>
							- {err.file}: {err.message}
						</Text>
					))}
					{summary.errors.length > 5 && (
						<Text dimColor>(+{summary.errors.length - 5} more)</Text>
					)}
				</Box>
			)}
			<Text dimColor>Source: {summary.outDir}</Text>
		</Box>
	);
}
