import { existsSync, rmSync } from "node:fs";
import { agentLogsDir, cliLogsDir } from "@/lib/paths.js";

// Hidden `codevhub clear-logs`: deletes both ~/.codev-hub log homes — the CLI's own
// diagnostics (cliLogsDir) and the conversation exports (agentLogsDir). Plain
// console output, no Ink and no prompt, matching the other hidden utility
// commands (hook/unhook). Each dir is removed only if it exists, so the report
// reflects what was actually there.
export function runClearLogs(): number {
	const targets: { label: string; path: string }[] = [
		{ label: "diagnostic logs", path: cliLogsDir() },
		{ label: "conversation exports", path: agentLogsDir() },
	];
	let removed = 0;
	for (const { label, path } of targets) {
		if (!existsSync(path)) {
			console.log(`Skipped ${label} (nothing at ${path})`);
			continue;
		}
		try {
			rmSync(path, { recursive: true, force: true });
			console.log(`Removed ${label} (${path})`);
			removed++;
		} catch (err) {
			console.error(`Failed to remove ${label} (${path}): ${String(err)}`);
			return 1;
		}
	}
	if (removed === 0) console.log("Nothing to remove.");
	return 0;
}
