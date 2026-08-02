import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { PasteBackPrompt, usePasteBack } from "@/components/PasteBack.js";
import { useCanType } from "@/components/useCanType.js";
import { t } from "@/lib/i18n.js";
import { runUpload, type UploadSummary } from "@/lib/upload.js";

type Phase = "running" | "done" | "error";

export function UploadApp({ force = false }: { force?: boolean }) {
	const { exit } = useApp();
	const canType = useCanType();
	const [phase, setPhase] = useState<Phase>("running");
	const [status, setStatus] = useState(t("upload.uploading"));
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
						<Text dimColor>{t("upload.browser_url")}</Text>
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
							<Text dimColor>{t("upload.no_keyboard")}</Text>
						)}
					</Box>
				)}
			</Box>
		);
	}

	if (phase === "error") {
		return (
			<Box flexDirection="column">
				<Text color="red">{t("upload.failed")}</Text>
				<Text dimColor>{error ?? t("tasklist.unknown_error")}</Text>
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
				<Text color="yellow">{t("upload.none_found")}</Text>
				{targets.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>{t("upload.looked_in")}</Text>
						{targets.map((target) => (
							<Text key={target.agent} dimColor>
								{"  • "}
								{target.agent}: {target.path}
							</Text>
						))}
					</Box>
				)}
				<Box marginTop={1}>
					<Text dimColor>{t("upload.launch_hint")}</Text>
				</Box>
			</Box>
		);
	}
	return (
		<Box flexDirection="column">
			<Text color={summary.failed > 0 ? "yellow" : "green"}>
				{t("upload.uploaded", {
					uploaded: summary.uploaded,
					found: summary.found,
				})}
			</Text>
			<Text dimColor>{t("upload.skipped", { count: summary.skipped })}</Text>
			{summary.failed > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="red">
						{t("upload.failed_logs", { count: summary.failed })}
					</Text>
					{summary.errors.slice(0, 5).map((err) => (
						<Text key={err.file} dimColor>
							- {err.file}: {err.message}
						</Text>
					))}
					{summary.errors.length > 5 && (
						<Text dimColor>
							{t("upload.more", { count: summary.errors.length - 5 })}
						</Text>
					)}
				</Box>
			)}
			<Text dimColor>{t("upload.source", { dir: summary.outDir })}</Text>
		</Box>
	);
}
