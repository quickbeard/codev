import { render } from "ink";
import { InstallApp } from "@/InstallApp.js";
import { logout } from "@/lib/auth.js";
import { printHelp, printVersion } from "@/lib/help.js";
import { ensureNodeSqliteOrReexec } from "@/lib/reexec.js";
import { runRestore } from "@/lib/restore.js";
import { runAgent } from "@/lib/run.js";
import { activationHint, installShims, uninstallShims } from "@/lib/shims.js";
import { runUploadDaemon, spawnUploadDaemon } from "@/lib/upload.js";
import { UpdateApp } from "@/UpdateApp.js";
import { UploadApp } from "@/UploadApp.js";

// `node:sqlite` (used by the OpenCode provider) was added in Node 22.5 and
// stabilized in Node 23.5. Earlier 22.x patches don't expose the module even
// with --experimental-sqlite.
const MIN_NODE_VERSION = "22.5.0";
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
	.split(".")
	.map((n) => Number.parseInt(n, 10) || 0);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5)) {
	console.error(
		`CoDev requires Node.js >= ${MIN_NODE_VERSION}. Current version: ${process.versions.node}.`,
	);
	process.exit(1);
}

async function gateSqlite(): Promise<void> {
	// `node:sqlite` is built into Node but only stable in 23.5+. On 22.5–23.4 it
	// requires the `--experimental-sqlite` flag, so we probe and (if needed)
	// re-exec the same process with the flag attached.
	const result = await ensureNodeSqliteOrReexec();
	if (result.action === "reexec") process.exit(result.exitCode ?? 1);
	if (result.action === "error") {
		console.error(result.error);
		process.exit(1);
	}
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
	// Hidden: not surfaced in --help or README. Installs/removes PATH shims
	// that route `claude`/`codex`/`opencode` through codev.
	case "block": {
		const r = installShims();
		console.log(`Installed shims in ${r.shimDir}`);
		for (const path of r.rcFilesUpdated) console.log(`  patched ${path}`);
		if (r.windowsUserPathUpdated) console.log("  updated user PATH");
		console.log(activationHint());
		process.exit(0);
		break;
	}
	case "unblock": {
		const r = uninstallShims();
		if (r.shimsRemoved.length === 0 && r.rcFilesUpdated.length === 0) {
			console.log("No codev shims installed.");
		} else {
			console.log(`Removed ${r.shimsRemoved.length} shim(s) from ${r.shimDir}`);
			for (const path of r.rcFilesUpdated) console.log(`  cleaned ${path}`);
			if (r.windowsUserPathUpdated) console.log("  updated user PATH");
			console.log(activationHint());
		}
		process.exit(0);
		break;
	}
	case "upload": {
		await gateSqlite();
		if (args.includes("--daemon")) {
			process.exit(await runUploadDaemon());
		}
		const { waitUntilExit } = render(<UploadApp />);
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
		spawnUploadDaemon();
		process.exit(await runAgent("claude", args));
		break;
	case "codex":
		if (args[0] === "--restore") {
			process.exit(runRestore("codex"));
		}
		spawnUploadDaemon();
		process.exit(await runAgent("codex", args));
		break;
	case "opencode":
		if (args[0] === "--restore") {
			process.exit(runRestore("opencode"));
		}
		spawnUploadDaemon();
		process.exit(await runAgent("opencode", args));
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
