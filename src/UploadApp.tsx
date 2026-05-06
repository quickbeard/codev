import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { runUpload, type UploadSummary } from "@/upload.js";

type Phase = "running" | "done" | "error";

interface UploadAppProps {
	skipExport?: boolean;
}

export function UploadApp({ skipExport = false }: UploadAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("running");
	const [status, setStatus] = useState("Uploading logs...");
	const [summary, setSummary] = useState<UploadSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runUpload({ skipExport, onStatus: setStatus })
			.then((result) => {
				setSummary(result);
				setPhase("done");
			})
			.catch((err) => {
				setError(String(err));
				setPhase("error");
			});
	}, [skipExport]);

	useEffect(() => {
		if (phase === "done" || phase === "error") {
			exit();
		}
	}, [phase, exit]);

	if (phase === "running") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner />
				</Text>
				<Text> {status}</Text>
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
