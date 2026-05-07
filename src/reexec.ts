import { spawnSync as nodeSpawnSync } from "node:child_process";

// Indirection so tests can stub the spawn call (mirrors `spawner` in upload.ts
// and `browserOpener` in auth.ts).
export const spawner = {
	spawnSync: nodeSpawnSync,
};

export interface ReexecResult {
	action: "ok" | "reexec" | "error";
	exitCode?: number;
	error?: string;
}

// Ensure `node:sqlite` is loadable in the current process. If it isn't, and
// we haven't already been re-execed, re-launch the same CLI invocation with
// `--experimental-sqlite` so the import will succeed in the child. The child
// inherits stdio, so the user sees no difference; we just exit with whatever
// exit code the child returns.
//
// Caller is responsible for short-circuiting this under Bun — Bun has no
// `node:sqlite` specifier and `process.execPath` points at the bun binary, so
// re-execing would just relaunch Bun with a flag it doesn't recognize.
// `gateSqlite()` in `index.tsx` does that bypass.
//
// `node:sqlite` is stable from Node 23.5 onward and gated behind
// `--experimental-sqlite` on Node 22.5–23.4. Node < 22.5 lacks the module
// entirely and is rejected at startup by the `MIN_NODE_VERSION` check in
// `index.tsx`, so a re-exec'd child that still can't import means something
// unexpected (e.g. `--experimental-sqlite` removed in a future Node) and we
// surface that rather than loop.
export async function ensureNodeSqliteOrReexec(): Promise<ReexecResult> {
	try {
		await import("node:sqlite");
		return { action: "ok" };
	} catch {
		// Module not available — either Node 22.5–23.4 without the flag, or a
		// future Node where the module moved. Try the flag-then-re-exec path.
	}

	if (process.execArgv.includes("--experimental-sqlite")) {
		return {
			action: "error",
			error:
				`OpenCode export needs node:sqlite, but it isn't loadable on Node ${process.versions.node} ` +
				"even with --experimental-sqlite. Upgrade to Node 22.5+.",
		};
	}

	const selfPath = process.argv[1];
	if (!selfPath) {
		return {
			action: "error",
			error: "cannot determine CLI entry path for re-exec",
		};
	}

	const result = spawner.spawnSync(
		process.execPath,
		[
			"--experimental-sqlite",
			"--no-warnings=ExperimentalWarning",
			...process.execArgv,
			selfPath,
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	return { action: "reexec", exitCode: result.status ?? 1 };
}
