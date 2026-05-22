import { spawn } from "node:child_process";
import { constants } from "node:os";
import { stripShimDirFromPath } from "@/lib/shims.js";

const AGENT_LABEL: Record<string, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
};

export function runAgent(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const label = AGENT_LABEL[cmd] ?? cmd;
		process.stderr.write(`Starting ${label}...\n`);
		// Strip ~/.codev/bin from the child's PATH so spawning `claude` resolves
		// the real npm-installed binary, not our shim — otherwise the shim would
		// re-exec `codev claude` and infinite-loop.
		const env = {
			...process.env,
			PATH: stripShimDirFromPath(process.env.PATH),
		};
		// On Windows, npm-installed agent binaries are `.cmd` shims (e.g.
		// `opencode.cmd`). Node's `spawn` only consults PATHEXT when `shell: true`,
		// so without this flag the spawn fails with ENOENT even though the agent
		// is installed. Mirrors the win32 handling in lib/npm.ts.
		const child = spawn(cmd, args, {
			stdio: "inherit",
			env,
			shell: process.platform === "win32",
		});

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
			if (err.code === "ENOENT") {
				console.error(
					`'${cmd}' could not be launched. If it isn't installed, run 'codev install'.`,
				);
			} else {
				console.error(`Failed to run ${cmd}: ${err.message}`);
			}
			resolve(1);
		});

		child.once("exit", (code, signal) => {
			cleanup();
			if (code !== null) {
				resolve(code);
				return;
			}
			const signo = signal ? (constants.signals[signal] ?? 0) : 0;
			resolve(128 + signo);
		});
	});
}
