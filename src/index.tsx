import { existsSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { render } from "ink";
import { ConfigApp } from "@/ConfigApp.js";
import { InstallApp } from "@/InstallApp.js";
import { LoginApp } from "@/LoginApp.js";
import { clearSkillhubCookie, logout } from "@/lib/auth.js";
import { runClearLogs } from "@/lib/clear-logs.js";
import { forwardToCodegraph } from "@/lib/codegraph.js";
import { printHelp, printVersion } from "@/lib/help.js";
import { initLogging } from "@/lib/log.js";
import { runLogs } from "@/lib/logs.js";
import { ensureNodeSqliteOrReexec } from "@/lib/reexec.js";
import { ensureFreshGatewayKey } from "@/lib/refresh.js";
import {
	RESTORE_AGENTS,
	type RestoreAgent,
	runRestore,
	runRestoreAll,
	toolForRestoreAgent,
} from "@/lib/restore.js";
import { agentOnPath, runAgent } from "@/lib/run.js";
import {
	activationHint,
	detectCodevTools,
	installShims,
	repairShims,
	SHIM_AGENTS,
	type ShimAgent,
	uninstallShims,
} from "@/lib/shims.js";
import { parsePullArgs, runSkillInstall } from "@/lib/skill-install.js";
import { parsePublishArgs, runSkillPublish } from "@/lib/skill-publish.js";
import { runSkillSearch } from "@/lib/skill-search.js";
import { runUploadDaemon, spawnUploadDaemon } from "@/lib/upload.js";
import { ModelApp } from "@/ModelApp.js";
import { RemoveApp } from "@/RemoveApp.js";
import { SkillPullApp } from "@/SkillPullApp.js";
import { SkillPushApp } from "@/SkillPushApp.js";
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

// Read the value of a `--name value` / `--name=value` flag from argv, or
// undefined when the flag is absent. Used for the non-interactive admin-login
// credentials on `codevhub login`.
function flagValue(argv: string[], name: string): string | undefined {
	const eq = `${name}=`;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === name) return argv[i + 1];
		if (arg?.startsWith(eq)) return arg.slice(eq.length);
	}
	return undefined;
}

// Diagnostic logging (~/.codev-hub/logs/codev-YYYYMMDD.ndjson, ECS NDJSON) starts
// before dispatch so every command logs its start/end and crashes. File-only —
// never stdout/stderr, which the Ink apps own.
initLogging(command ?? "help", args);

// Rewrite shims left behind by pre-0.4 hub versions (their bodies re-exec the
// old `codev` hub command, which is now the agent). Best-effort: a filesystem
// hiccup here must never block the actual command.
try {
	repairShims();
} catch {
	// Ignore — `codevhub install`/`hook` can rebuild shims explicitly.
}

switch (command) {
	// Bare `codevhub` opens CoDev Code (the built-in coding agent) in the
	// current directory. Fall back to the hub help when the agent isn't
	// installed yet, so first-run users get orientation instead of a launch
	// error.
	case undefined: {
		if (!agentOnPath("codev")) {
			printHelp();
			process.exit(0);
		}
		spawnUploadDaemon();
		await ensureFreshGatewayKey("codev-code");
		process.exit(await runAgent("codev", []));
		break;
	}
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
		const username = flagValue(args, "--username");
		const password = flagValue(args, "--password");
		// Passing either credential implies the admin (username/password) flow, so
		// `codevhub login --username u --password p` works without also typing
		// --admin.
		const admin =
			args.includes("--admin") ||
			username !== undefined ||
			password !== undefined;
		// Non-interactive admin login needs both halves; one alone is a usage error.
		if ((username === undefined) !== (password === undefined)) {
			console.error(
				"codevhub login: --username and --password must be provided together.",
			);
			process.exit(1);
		}
		const { waitUntilExit } = render(
			<LoginApp
				force={force}
				admin={admin}
				username={username}
				password={password}
			/>,
		);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "logout": {
		// Full sign-out: drop the SSO session AND any SkillHub admin cookie.
		const ssoOut = await logout();
		const cookieOut = clearSkillhubCookie();
		console.log(ssoOut || cookieOut ? "Logged out." : "Not logged in.");
		process.exit(0);
		break;
	}
	case "remove": {
		const skipConfirm = args.includes("--yes") || args.includes("-y");
		// Undocumented (see `restore` below). Long form only — no `-f` alias, so a
		// reflex `-f` borrowed from `upload` can't unconditionally delete configs.
		const force = args.includes("--force");
		const { waitUntilExit } = render(
			<RemoveApp skipConfirm={skipConfirm} force={force} />,
		);
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
	case "upload": {
		await gateSqlite();
		if (args.includes("--daemon")) {
			process.exit(await runUploadDaemon());
		}
		const force = args.includes("--force") || args.includes("-f");
		const { waitUntilExit } = render(<UploadApp force={force} />);
		try {
			await waitUntilExit();
			process.exit(0);
		} catch {
			process.exit(1);
		}
		break;
	}
	case "logs": {
		process.exit(runLogs(args));
		break;
	}
	// `--force` is a deliberate escape hatch and is deliberately absent from
	// `help.ts`: it deletes a backup-less live config whoever wrote it, skipping
	// the authorship check that normally preserves the user's own files. It never
	// overrides a `*.backup`, which is still restored. Long form only — no `-f`
	// alias, so the reflex `-f` from `upload`/`login` can't trigger it by
	// accident. Nothing invokes it on the user's behalf; it only fires when typed.
	case "restore": {
		const force = args.includes("--force");
		const agent = args.find((a) => !a.startsWith("-"));
		if (agent === undefined) {
			process.exit(runRestoreAll(force));
		}
		if (!(RESTORE_AGENTS as readonly string[]).includes(agent)) {
			console.error(
				`Unknown agent: ${agent}. Valid: ${RESTORE_AGENTS.join(", ")}.`,
			);
			process.exit(1);
		}
		process.exit(runRestore(toolForRestoreAgent(agent as RestoreAgent), force));
		break;
	}
	// `codevhub init` initializes the current project for CoDev. Hint that the
	// generated `.codegraph/` directory should be committed so the whole team
	// shares one knowledge graph — but only if it's actually on disk afterward.
	// `codegraph init` exits 0 on no-ops too (e.g. `--help`), so we gate on the
	// artifact existing rather than the exit code alone. `init [path]` writes
	// into the given directory (the first non-flag arg), defaulting to cwd.
	case "init": {
		const code = await forwardToCodegraph(["init", ...args]);
		const targetDir = args.find((a) => !a.startsWith("-")) ?? ".";
		if (code === 0 && existsSync(join(targetDir, ".codegraph"))) {
			console.log(
				`Created the local ${styleText("cyan", ".codegraph/")} directory. ` +
					"You can commit it if you'd like to share the knowledge graph with " +
					"your team.",
			);
		}
		process.exit(code);
		break;
	}
	// `skill <subcommand>`: operations against the SkillHub registry. Namespaced
	// so it doesn't collide with `codevhub install` (which installs agents).
	// `pull` downloads/installs a skill (not `install`, to avoid that confusion);
	// `push` publishes one; whoami migrates here next.
	case "skill": {
		const [sub, ...rest] = args;
		if (sub === "search") {
			process.exit(await runSkillSearch(rest));
		}
		if (sub === "push") {
			const parsed = parsePublishArgs(rest);
			if (!parsed.path) {
				console.error(
					"Usage: codevhub skill push <path> [--draft-only] [--auto-approve] [--json]",
				);
				process.exit(1);
			}
			// Interactive TTY (and not --json): preview + confirm before uploading
			// (Ink). Otherwise (piped/CI, or --json) go the plain runner.
			const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
			if (interactive && !parsed.json) {
				let ok = true;
				const { waitUntilExit } = render(
					<SkillPushApp
						path={parsed.path}
						json={parsed.json}
						draftOnly={parsed.draftOnly}
						autoApprove={parsed.autoApprove}
						onDone={(v) => {
							ok = v;
						}}
					/>,
				);
				try {
					await waitUntilExit();
				} catch {
					process.exit(1);
				}
				process.exit(ok ? 0 : 1);
			}
			process.exit(await runSkillPublish(rest));
		}
		if (sub === "pull") {
			const parsed = parsePullArgs(rest);
			if (parsed.error) {
				console.error(parsed.error);
				process.exit(1);
			}
			if (!parsed.target) {
				console.error(
					"Usage: codevhub skill pull <name|id> [--dir <path>] [--force] [--json]",
				);
				process.exit(1);
			}
			// Interactive + no explicit --dir: prompt for the location (Ink).
			// Otherwise (--dir given, or piped/CI) go the plain non-interactive path.
			const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
			if (parsed.dir === undefined && interactive) {
				let ok = true;
				const { waitUntilExit } = render(
					<SkillPullApp
						target={parsed.target}
						force={parsed.force}
						json={parsed.json}
						onDone={(v) => {
							ok = v;
						}}
					/>,
				);
				try {
					await waitUntilExit();
				} catch {
					process.exit(1);
				}
				process.exit(ok ? 0 : 1);
			}
			process.exit(await runSkillInstall(rest));
		}
		console.error(
			sub === undefined
				? "Usage: codevhub skill <search|pull|push> ..."
				: `Unknown skill subcommand: ${sub}. Valid: search, pull, push.`,
		);
		process.exit(1);
		break;
	}
	case "claude":
		spawnUploadDaemon();
		await ensureFreshGatewayKey("claude-code");
		process.exit(await runAgent("claude", args));
		break;
	case "codex":
		spawnUploadDaemon();
		await ensureFreshGatewayKey("codex");
		process.exit(await runAgent("codex", args));
		break;
	case "opencode":
		spawnUploadDaemon();
		await ensureFreshGatewayKey("opencode");
		process.exit(await runAgent("opencode", args));
		break;
	case "codev":
		spawnUploadDaemon();
		await ensureFreshGatewayKey("codev-code");
		process.exit(await runAgent("codev", args));
		break;
	// Transparent passthrough to CodeGraph: `codevhub codegraph <args>` ≡
	// `codegraph <args>` (e.g. `codevhub codegraph init`). No upload daemon and
	// no shim handling — CodeGraph isn't a chat agent and isn't shimmed.
	case "codegraph":
		process.exit(await forwardToCodegraph(args));
		break;
	// ── Hidden commands ──────────────────────────────────────────────────
	// Intentionally not surfaced in --help, README, or AGENTS.md. Kept
	// grouped at the end of the switch, after every documented command.
	//
	// `hook`/`unhook`: install/remove the PATH shims that route
	// `claude`/`codex`/`opencode`/`codev` through codevhub.
	case "hook": {
		let agents: readonly ShimAgent[];
		if (args.length === 0) {
			agents = detectCodevTools();
			if (agents.length === 0) {
				console.log(
					"No CoDev-installed tools found. Run `codevhub install` first, " +
						"or specify agents explicitly: `codevhub hook claude|codex|opencode`.",
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
			console.log("No CoDev shims installed.");
		} else {
			console.log(`Removed ${r.shimsRemoved.length} shim(s) from ${r.shimDir}`);
			for (const path of r.rcFilesUpdated) console.log(`  cleaned ${path}`);
			if (r.windowsUserPathUpdated) console.log("  updated user PATH");
			console.log(activationHint());
		}
		process.exit(0);
		break;
	}
	// `clear-logs`: deletes both ~/.codev-hub log homes — the CLI diagnostics
	// (cliLogsDir) and the conversation exports (agentLogsDir).
	case "clear-logs": {
		process.exit(runClearLogs());
		break;
	}
	// Every command not claimed by the hub above belongs to CoDev Code:
	// `codevhub run "..."`, `codevhub serve`, `codevhub models`, a project
	// path, etc. Hub commands always win on a name collision (the sync
	// checklist in the codev-code repo watches for new upstream commands);
	// running `codev` directly is the escape hatch to a shadowed command.
	default:
		spawnUploadDaemon();
		await ensureFreshGatewayKey("codev-code");
		process.exit(await runAgent("codev", [command, ...args]));
}
