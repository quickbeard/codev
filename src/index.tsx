import { render } from "ink";
import { ConfigApp } from "@/ConfigApp.js";
import { InstallApp } from "@/InstallApp.js";
import { LoginApp } from "@/LoginApp.js";
import { logout } from "@/lib/auth.js";
import { forwardToCodegraph } from "@/lib/codegraph.js";
import { printHelp, printVersion } from "@/lib/help.js";
import { ensureNodeSqliteOrReexec } from "@/lib/reexec.js";
import {
	RESTORE_AGENTS,
	type RestoreAgent,
	runRestore,
	runRestoreAll,
	toolForRestoreAgent,
} from "@/lib/restore.js";
import { runAgent } from "@/lib/run.js";
import {
	activationHint,
	detectCodevTools,
	installShims,
	SHIM_AGENTS,
	type ShimAgent,
	uninstallShims,
} from "@/lib/shims.js";
import { runUploadDaemon, spawnUploadDaemon } from "@/lib/upload.js";
import { ModelApp } from "@/ModelApp.js";
import { RemoveApp } from "@/RemoveApp.js";
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
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "config": {
		const { waitUntilExit } = render(<ConfigApp />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
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
	case "login": {
		const force = args.includes("--force") || args.includes("-f");
		const { waitUntilExit } = render(<LoginApp force={force} />);
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
	case "remove": {
		const skipConfirm = args.includes("--yes") || args.includes("-y");
		const { waitUntilExit } = render(<RemoveApp skipConfirm={skipConfirm} />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "model": {
		const { waitUntilExit } = render(<ModelApp />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	// Hidden: not surfaced in --help or README. Installs/removes PATH shims
	// that route `claude`/`codex`/`opencode` through codev.
	case "hook": {
		let agents: readonly ShimAgent[];
		if (args.length === 0) {
			agents = detectCodevTools();
			if (agents.length === 0) {
				console.log(
					"No CoDev-installed tools found. Run `codev install` first, " +
						"or specify agents explicitly: `codev hook claude|codex|opencode`.",
				);
				process.exit(0);
			}
		} else {
			const invalid = args.filter(
				(a) => !(SHIM_AGENTS as readonly string[]).includes(a),
			);
			if (invalid.length > 0) {
				console.error(
					`Unknown agent(s): ${invalid.join(", ")}. Valid: ${SHIM_AGENTS.join(", ")}.`,
				);
				process.exit(1);
			}
			agents = args as ShimAgent[];
		}
		const r = installShims(agents);
		console.log(`Installed shims in ${r.shimDir}`);
		for (const path of r.rcFilesUpdated) console.log(`  patched ${path}`);
		if (r.windowsUserPathUpdated) console.log("  updated user PATH");
		console.log(activationHint());
		process.exit(0);
		break;
	}
	case "unhook": {
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
	case "restore": {
		const agent = args[0];
		if (agent === undefined) {
			process.exit(runRestoreAll());
		}
		if (!(RESTORE_AGENTS as readonly string[]).includes(agent)) {
			console.error(
				`Unknown agent: ${agent}. Valid: ${RESTORE_AGENTS.join(", ")}.`,
			);
			process.exit(1);
		}
		process.exit(runRestore(toolForRestoreAgent(agent as RestoreAgent)));
		break;
	}
	case "claude":
		spawnUploadDaemon();
		process.exit(await runAgent("claude", args));
		break;
	case "codex":
		spawnUploadDaemon();
		process.exit(await runAgent("codex", args));
		break;
	case "opencode":
		spawnUploadDaemon();
		process.exit(await runAgent("opencode", args));
		break;
	// Transparent passthrough to CodeGraph: `codev codegraph <args>` ≡
	// `codegraph <args>` (e.g. `codev codegraph init -y`). No upload daemon and
	// no shim handling — CodeGraph isn't a chat agent and isn't shimmed.
	case "codegraph":
		process.exit(await forwardToCodegraph(args));
		break;
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
