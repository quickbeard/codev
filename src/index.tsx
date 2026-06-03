import { render } from "ink";
import { ConfigApp } from "@/ConfigApp.js";
import { InstallApp } from "@/InstallApp.js";
import { LeaderboardApp } from "@/LeaderboardApp.js";
import { LoginApp } from "@/LoginApp.js";
import { browserOpener, logout } from "@/lib/auth.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import {
	printHelp,
	printSkillHelp,
	printSkillInstallHelp,
	printSkillPublishHelp,
	printSkillSearchHelp,
	printSkillUploadHelp,
	printVersion,
} from "@/lib/help.js";
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
import { MySkillsApp } from "@/MySkillsApp.js";
import { NamespaceSkillsApp } from "@/NamespaceSkillsApp.js";
import { NamespacesApp } from "@/NamespacesApp.js";
import { RemoveApp } from "@/RemoveApp.js";
import { type SkillAgent, SkillInstallApp } from "@/SkillInstallApp.js";
import { SkillPublishApp } from "@/SkillPublishApp.js";
import { SkillSearchApp } from "@/SkillSearchApp.js";
import { SkillUploadApp } from "@/SkillUploadApp.js";
import { SkillUserApp } from "@/SkillUserApp.js";
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
	case "skill": {
		const [sub, ...subArgs] = args;
		const wantsHelp = subArgs.includes("--help") || subArgs.includes("-h");

		if (!sub || sub === "--help" || sub === "-h") {
			printSkillHelp();
			process.exit(0);
		}

		if (sub === "search") {
			if (wantsHelp) {
				printSkillSearchHelp();
				process.exit(0);
			}
			const query = subArgs.find((a) => !a.startsWith("-"));
			const { waitUntilExit } = render(<SkillSearchApp query={query} />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "install") {
			if (wantsHelp) {
				printSkillInstallHelp();
				process.exit(0);
			}
			const skillName = subArgs.find((a) => !a.startsWith("-"));
			if (!skillName) {
				console.error(
					"Missing skill name.\n\n" +
						"  Usage:   codev skill install <name>\n" +
						"  Find skills: codev skill search\n",
				);
				process.exit(1);
			}
			const force = subArgs.includes("--force") || subArgs.includes("-f");
			const agentIdx = subArgs.indexOf("--agent");
			const agentRaw = agentIdx !== -1 ? subArgs[agentIdx + 1] : undefined;
			if (agentRaw && agentRaw !== "claude" && agentRaw !== "opencode") {
				console.error(
					`Unknown agent: "${agentRaw}"\n\n` +
						"  Valid:   --agent claude\n" +
						"           --agent opencode\n",
				);
				process.exit(1);
			}
			const agent = (agentRaw as SkillAgent | undefined) ?? "claude";
			const { waitUntilExit } = render(
				<SkillInstallApp name={skillName} agent={agent} force={force} />,
			);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "open") {
			// Open via OIDC login so the user is automatically signed in.
			// SkillHub shares Viettel SSO with CoDev — the existing browser
			// SSO session silently authenticates without showing a login form.
			const url = `${SKILLHUB_REGISTRY}/api/auth/oidc/login?redirect=/profile`;
			console.log(`Opening SkillHub (signing in via SSO)...`);
			await browserOpener.open(url);
			process.exit(0);
		} else if (sub === "my") {
			const { waitUntilExit } = render(<MySkillsApp />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "upload") {
			if (wantsHelp) {
				printSkillUploadHelp();
				process.exit(0);
			}
			const inputPath = subArgs.find((a) => !a.startsWith("-"));
			if (!inputPath) {
				console.error(
					"Missing path.\n\n" +
						"  Usage:   codev skill upload <path>\n" +
						"  Help:    codev skill upload --help\n",
				);
				process.exit(1);
			}
			const nsIdx = subArgs.indexOf("--namespace");
			const namespaceVal = nsIdx !== -1 ? subArgs[nsIdx + 1] : undefined;
			if (nsIdx !== -1 && (!namespaceVal || namespaceVal.startsWith("-"))) {
				console.error(
					"--namespace requires a slug value.\n\n" +
						"  Usage: codev skill upload <path> --namespace <slug>\n",
				);
				process.exit(1);
			}
			const namespace = namespaceVal;
			const submitFlag = subArgs.includes("--submit") || subArgs.includes("-s");
			const { waitUntilExit } = render(
				<SkillUploadApp
					inputPath={inputPath}
					namespace={namespace}
					submit={submitFlag}
				/>,
			);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "publish") {
			if (wantsHelp) {
				printSkillPublishHelp();
				process.exit(0);
			}
			const skillName = subArgs.find((a) => !a.startsWith("-"));
			if (!skillName) {
				console.error(
					"Missing skill name.\n\n" +
						"  Usage:   codev skill publish <name>\n" +
						"  Help:    codev skill publish --help\n",
				);
				process.exit(1);
			}
			const { waitUntilExit } = render(<SkillPublishApp name={skillName} />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "namespaces") {
			const { waitUntilExit } = render(<NamespacesApp />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "leaderboard") {
			const { waitUntilExit } = render(<LeaderboardApp />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "user") {
			const username = subArgs.find((a) => !a.startsWith("-"));
			if (!username) {
				console.error(
					"Missing username.\n\n" +
						"  Usage:   codev skill user <username>\n" +
						"  Example: codev skill user tieuanh\n",
				);
				process.exit(1);
			}
			const { waitUntilExit } = render(<SkillUserApp username={username} />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else if (sub === "ns") {
			const slug = subArgs.find((a) => !a.startsWith("-"));
			if (!slug) {
				console.error(
					"Missing namespace slug.\n\n" +
						"  Usage:       codev skill ns <slug>\n" +
						"  List yours:  codev skill namespaces\n",
				);
				process.exit(1);
			}
			const { waitUntilExit } = render(<NamespaceSkillsApp slug={slug} />);
			try {
				await waitUntilExit();
				process.exit(0);
			} catch {
				process.exit(1);
			}
		} else {
			console.error(
				`Unknown subcommand: "${sub}"\n\n` +
					"  Available: search, install, open, leaderboard, user, my, upload, publish, namespaces, ns\n" +
					"  Run codev skill --help for usage.\n",
			);
			process.exit(1);
		}
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
	default:
		console.error(`Unknown command: ${command}\n`);
		printHelp();
		process.exit(1);
}
