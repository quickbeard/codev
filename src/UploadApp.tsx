import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { runUpload, type UploadSummary } from "@/lib/upload.js";

type Phase = "running" | "done" | "error";

export function UploadApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("running");
	const [status, setStatus] = useState("Uploading logs...");
	const [loginUrl, setLoginUrl] = useState<string | null>(null);
	const [pasteValue, setPasteValue] = useState("");
	const [pasteError, setPasteError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [summary, setSummary] = useState<UploadSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);
	const submitManualCodeRef = useRef<
		((pasted: string) => string | null) | null
	>(null);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runUpload({
			onStatus: setStatus,
			onLoginUrl: setLoginUrl,
			onManualSubmit: (submit) => {
				submitManualCodeRef.current = submit;
			},
		})
			.then((result) => {
				setSummary(result);
				setPhase("done");
			})
			.catch((err) => {
				setError(String(err));
				setPhase("error");
			});
	}, []);

	useEffect(() => {
		if (phase === "done" || phase === "error") {
			exit();
		}
	}, [phase, exit]);

	// The manual paste-back field is live only while a fresh interactive SSO
	// login is pending (loginUrl set) and before the user submits. Mirrors the
	// field in <Login> for no-browser users; the char-accumulation idiom matches
	// ManualCredentials/ProxyUrl.
	const pasteActive = phase === "running" && loginUrl !== null && !submitting;
	useInput(
		(input, key) => {
			if (!submitManualCodeRef.current) return;
			if (key.return) {
				const err = submitManualCodeRef.current(pasteValue.trim());
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
			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;
			setPasteValue((prev) => prev + cleaned);
			setPasteError(null);
		},
		{ isActive: pasteActive },
	);

	if (phase === "running") {
		return (
			<Box flexDirection="column">
				<Box>
					<Text color="cyan">
						<Spinner />
					</Text>
					<Text> {status}</Text>
				</Box>
				{loginUrl && !submitting && (
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>
							{"If the browser didn't open, visit this URL manually:"}
						</Text>
						<Text>{loginUrl}</Text>
						<Box flexDirection="column" marginTop={1}>
							<Text dimColor>
								{
									"On a remote or headless machine? After you sign in, the browser"
								}
							</Text>
							<Text dimColor>
								{
									"can't load the localhost page it lands on — paste that page's full"
								}
							</Text>
							<Text dimColor>{"URL (or just the code) here:"}</Text>
							<Box>
								<Text color="cyan">{"> "}</Text>
								<Text>{pasteValue}</Text>
								<Text color="cyan">▌</Text>
							</Box>
							{pasteError && <Text color="red">{pasteError}</Text>}
							<Text dimColor>{"Press Enter to submit."}</Text>
						</Box>
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
