#!/usr/bin/env node
import { render } from "ink";
import { logout } from "@/auth.js";
import { isAuthenticatedForUpload, parseAutoUploadFlag } from "@/autoUpload.js";
import { BackgroundUploadApp } from "@/BackgroundUploadApp.js";
import { ExportApp } from "@/ExportApp.js";
import { printHelp, printVersion } from "@/help.js";
import { InstallApp } from "@/InstallApp.js";
import { runRestore } from "@/restore.js";
import { runAgent } from "@/run.js";
import { UpdateApp } from "@/UpdateApp.js";
import { UploadApp } from "@/UploadApp.js";
import { runUpload } from "@/upload.js";

const MIN_NODE_MAJOR = 22;
const nodeMajor = Number.parseInt(
	process.versions.node.split(".")[0] ?? "0",
	10,
);
if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
	console.error(
		`CoDev requires Node.js >= ${MIN_NODE_MAJOR}. Current version: ${process.versions.node}.`,
	);
	process.exit(1);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case undefined:
	case "--help":
	case "-h":
	case "help":
		printHelp();
		process.exit(0);
		break;
	case "--version":
	case "-v":
	case "version":
		printVersion();
		process.exit(0);
		break;
	case "install": {
		const { waitUntilExit } = render(<InstallApp />);
		await waitUntilExit();
		process.exit(0);
		break;
	}
	case "update": {
		const { waitUntilExit } = render(<UpdateApp />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "logout": {
		const ok = await logout();
		console.log(ok ? "Logged out." : "Not logged in.");
		process.exit(0);
		break;
	}
	case "export": {
		const { waitUntilExit } = render(<ExportApp />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "upload": {
		const { waitUntilExit } = render(
			<UploadApp skipExport={args.includes("--skip-export")} />,
		);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "claude":
		if (args[0] === "--restore") {
			process.exit(runRestore("claude-code"));
		}
		process.exit(await runAgentWithAutoUpload("claude", args));
		break;
	case "codex":
		if (args[0] === "--restore") {
			process.exit(runRestore("codex"));
		}
		process.exit(await runAgentWithAutoUpload("codex", args));
		break;
	case "opencode":
		if (args[0] === "--restore") {
			process.exit(runRestore("opencode"));
		}
		process.exit(await runAgentWithAutoUpload("opencode", args));
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}

async function runAgentWithAutoUpload(
	cmd: string,
	rawArgs: string[],
): Promise<number> {
	const { agentArgs, autoUpload } = parseAutoUploadFlag(rawArgs);
	const willUpload = autoUpload && isAuthenticatedForUpload();

	// Start the pre-session upload silently in the background — previous
	// session uploads shouldn't delay or clutter a new coding session.
	const preUpload = willUpload ? runSilentUpload() : null;

	const code = await runAgent(cmd, agentArgs);

	// Await the pre-session upload (likely already done) then run the
	// post-session upload to capture the session that just finished.
	if (willUpload) {
		await preUpload;
		await renderBackgroundUpload("Stopping...");
	} else if (autoUpload) {
		console.log(
			"\nTip: run `codev upload` to sign in and enable automatic session uploads.",
		);
	}
	return code;
}

async function runSilentUpload(): Promise<void> {
	try {
		await runUpload({ onStatus: () => {} });
	} catch {
		// Best-effort — never block the agent lifecycle on a failed upload.
	}
}

async function renderBackgroundUpload(label: string): Promise<void> {
	const { waitUntilExit } = render(<BackgroundUploadApp label={label} />);
	try {
		await waitUntilExit();
	} catch {
		// Best-effort — never block the agent lifecycle on a failed upload.
	}
}
