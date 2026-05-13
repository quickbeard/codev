import { spawn } from "node:child_process";
import { constants } from "node:os";
import { stripShimDirFromPath } from "@/lib/shims.js";

export function runAgent(cmd: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		// Strip ~/.codev/bin from the child's PATH so spawning `claude` resolves
		// the real npm-installed binary, not our shim — otherwise the shim would
		// re-exec `codev claude` and infinite-loop.
		const env = {
			...process.env,
			PATH: stripShimDirFromPath(process.env.PATH),
		};
		const child = spawn(cmd, args, { stdio: "inherit", env });

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
					`'${cmd}' is not installed. Run 'codev install' to install it.`,
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
