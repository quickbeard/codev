import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Tool } from "@/lib/configure.js";
import { t } from "@/lib/i18n.js";

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
				<Text dimColor>{t("common.hint.help")}</Text>
			</Box>
			<Text bold color="magenta">
				{t("common.happy_coding")}
			</Text>
		</Box>
	);
}

function resumeMessage(tools: Tool[], shimsInstalled: boolean): ReactNode {
	if (tools.length === 0) return null;
	if (!shimsInstalled) return <Text>{t("common.done")}</Text>;
	if (process.platform === "win32") {
		return <Text>{t("setup.complete.restart_terminal")}</Text>;
	}
	return (
		<Text>
			{t("setup.complete.reload_shell_prefix")}
			<Text color="cyan">exec $SHELL</Text>
			{t("setup.complete.reload_shell_suffix")}
		</Text>
	);
}
