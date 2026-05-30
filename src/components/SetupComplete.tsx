import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Tool } from "@/lib/configure.js";
import { HAPPY_CODING, HELP_HINT } from "@/lib/const.js";

interface SetupCompleteProps {
	tools: Tool[];
	// When true, the resume line merges in the shim-activation hint
	// (platform-aware: `exec $SHELL` on Unix, "Restart your terminal" on Win).
	shimsInstalled: boolean;
}

// Terminal frame the user sees once SetupApp reaches the "done" Phase. Lifted
// out of Configure so the resume message can read shimsInstalled at a moment
// when the finalize Phase has actually populated it.
export function SetupComplete({ tools, shimsInstalled }: SetupCompleteProps) {
	return (
		<Box marginTop={1} marginBottom={1} flexDirection="column">
			{resumeMessage(tools, shimsInstalled)}
			<Box marginTop={1}>
				<Text dimColor>{HELP_HINT}</Text>
			</Box>
			<Text bold color="magenta">
				{HAPPY_CODING}
			</Text>
		</Box>
	);
}

function resumeMessage(tools: Tool[], shimsInstalled: boolean): ReactNode {
	if (tools.length === 0) return null;
	if (!shimsInstalled) return <Text>Done!</Text>;
	if (process.platform === "win32") {
		return <Text>Done! Restart your terminal.</Text>;
	}
	return (
		<Text>
			{"Done! Run "}
			<Text color="cyan">exec $SHELL</Text>
			{" to reload your shell."}
		</Text>
	);
}
