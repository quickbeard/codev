import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { runUpload } from "@/upload.js";

type Phase = "running" | "done";

interface BackgroundUploadAppProps {
	// Short label rendered next to the spinner, e.g. "Starting..." or
	// "Stopping...". The verbose per-file summary that `UploadApp` prints is
	// intentionally suppressed here so the upload looks like a quick lifecycle
	// step around the agent session.
	label: string;
}

export function BackgroundUploadApp({ label }: BackgroundUploadAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("running");
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		runUpload({ onStatus: () => {} })
			.then(() => setPhase("done"))
			.catch(() => setPhase("done"));
	}, []);

	useEffect(() => {
		if (phase === "done") {
			exit();
		}
	}, [phase, exit]);

	if (phase === "done") return null;

	return (
		<Box>
			<Text color="cyan">
				<Spinner />
			</Text>
			<Text> {label}</Text>
		</Box>
	);
}
