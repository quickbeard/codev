import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { constants } from "node:os";
import { delimiter, join } from "node:path";
import { logError, logInfo, logWarn } from "@/lib/log.js";
import { claudeNativeBinaryMissing } from "@/lib/npm.js";
import { stripShimDirFromPath } from "@/lib/shims.js";
import { childCaEnv } from "@/lib/tls.js";

const AGENT_LABEL: Record<string, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	codev: "CoDev Code",
};

// Indirection so tests can stub the spawn call without intercepting
// node:child_process at the module level (mirrors `spawner` in upload.ts and
// reexec.ts, and `browserOpener` in auth.ts).
export const spawner = {
	spawn: nodeSpawn,
};

// Cheap PATH probe (no child process) used by the bare-`codevhub` dispatch to
// decide between opening CoDev Code and falling back to the hub help. Skips
// the shim dir, mirroring the spawn PATH below. Windows spawns go through the
// shell (PATHEXT resolution), so probe the standard executable extensions.
export function agentOnPath(cmd: string): boolean {
	const exts =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
			: [""];
	for (const dir of stripShimDirFromPath(process.env.PATH).split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				accessSync(join(dir, cmd + ext), fsConstants.X_OK);
				return true;
			} catch {
				// Not here — keep scanning.
			}
		}
	}
	return false;
}

export function runAgent(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const label = AGENT_LABEL[cmd] ?? cmd;
		process.stderr.write(`Starting ${label}...\n`);
		// Agent args can carry prompt text (`codevhub claude -p "..."`) — log only
		// the count, never the contents.
		logInfo(`launching ${label}`, {
			action: "process.spawn",
			eventType: "start",
			extra: { agent: cmd, args_count: args.length },
		});
		// Strip ~/.codev-hub/bin from the child's PATH so spawning `claude` resolves
		// the real npm-installed binary, not our shim — otherwise the shim would
		// re-exec `codevhub claude` and infinite-loop.
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: stripShimDirFromPath(process.env.PATH),
			// OpenCode and CoDev Code are Bun binaries, which ignore the OS trust
			// store — behind an intercepting proxy they fail like we did until
			// handed our bundle. Claude Code and Codex read the OS store natively
			// and don't need this; it's harmless to them because
			// NODE_EXTRA_CA_CERTS appends rather than replaces. Only set once
			// something has detected interception, so this is one existsSync.
			...childCaEnv(),
		};
		// CoDev Code (the codev-code package) has its own self-updater, but the
		// hub owns updates (`codevhub update`) — disable the agent's updater at
		// every launch so the two never race.
		if (cmd === "codev") {
			env.OPENCODE_DISABLE_AUTOUPDATE = "1";
		}
		// On Windows, npm-installed agent binaries are `.cmd` shims (e.g.
		// `opencode.cmd`). Node's `spawn` only consults PATHEXT when shell is
		// enabled, so without it the spawn fails with ENOENT even though the
		// agent is installed. Mirrors the win32 handling in lib/npm.ts.
		//
		// Use the single-string form on Windows — Node 22's DEP0190 deprecates
		// `shell:true` combined with a separate `args` array (the args get
		// naively concatenated and not escaped, which is a command-injection
		// hazard for callers that take untrusted args). For us the args come
		// from process.argv and the concatenation behavior was already the
		// status quo, so this is a byte-for-byte equivalent rewrite that
		// silences the warning.
		const child =
			process.platform === "win32"
				? spawner.spawn(`${cmd} ${args.join(" ")}`, {
						stdio: "inherit",
						env,
						shell: true,
					})
				: spawner.spawn(cmd, args, { stdio: "inherit", env });

		// The child shares our process group, so the terminal already delivers
		// SIGINT/SIGTERM to it. Swallow them in the parent so we don't exit
		// before the child finishes its own cleanup.
		const swallow = () => {};
		process.on("SIGINT", swallow);
		process.on("SIGTERM", swallow);

		const cleanup = () => {
			process.off("SIGINT", swallow);
			process.off("SIGTERM", swallow);
		};

		child.once("error", (err: NodeJS.ErrnoException) => {
			cleanup();
			logError(`failed to launch ${label}`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				err,
				extra: { agent: cmd, code: err.code ?? null },
			});
			if (err.code === "ENOENT") {
				console.error(
					`'${cmd}' could not be launched. If it isn't installed, run 'codevhub install'.`,
				);
			} else {
				console.error(`Failed to run ${cmd}: ${err.message}`);
			}
			resolve(1);
		});

		child.once("exit", async (code, signal) => {
			cleanup();
			if (code !== null) {
				// A non-zero `claude` exit can be the leftover placeholder stub
				// erroring with "native binary not installed" (suppressed
				// postinstall / omitted optional dependency). The stub already
				// printed its own message via inherited stderr; we only add a
				// codev-specific repair hint when we can positively confirm the
				// native binary is missing, so normal claude failures stay quiet.
				if (
					code !== 0 &&
					cmd === "claude" &&
					(await claudeNativeBinaryMissing())
				) {
					process.stderr.write(
						"\nclaude's native binary is missing. Run 'codevhub install' to repair it " +
							"(reinstalls Claude Code with the platform binary included).\n",
					);
				}
				(code === 0 ? logInfo : logWarn)(`${label} exited (code ${code})`, {
					action: "process.exit",
					eventType: "end",
					outcome: code === 0 ? "success" : "failure",
					extra: { agent: cmd, exit_code: code },
				});
				resolve(code);
				return;
			}
			const signo = signal ? (constants.signals[signal] ?? 0) : 0;
			logWarn(`${label} exited (signal ${signal})`, {
				action: "process.exit",
				eventType: "end",
				outcome: "failure",
				extra: { agent: cmd, exit_code: 128 + signo, signal },
			});
			resolve(128 + signo);
		});
	});
}
