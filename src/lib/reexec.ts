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

let warningFilterInstalled = false;

// Drop Node's "SQLite is an experimental feature" ProcessWarning while letting
// every other warning fall through to the default printer. Needed on Node 22.x
// patches that expose `node:sqlite` unflagged: the probe import below succeeds
// but emits the warning before returning, so `--disable-warning` in a re-exec
// child can't help — we never re-exec on that path.
function suppressSqliteExperimentalWarning(): void {
	if (warningFilterInstalled) return;
	warningFilterInstalled = true;
	const originalListeners = process.listeners("warning");
	process.removeAllListeners("warning");
	process.on("warning", (warning) => {
		if (
			warning.name === "ExperimentalWarning" &&
			/SQLite/i.test(warning.message)
		) {
			return;
		}
		for (const listener of originalListeners) listener(warning);
	});
}

// Ensure `node:sqlite` is loadable in the current process. If it isn't, and
// we haven't already been re-execed, re-launch the same CLI invocation with
// `--experimental-sqlite` so the import will succeed in the child. The child
// inherits stdio, so the user sees no difference; we just exit with whatever
// exit code the child returns.
//
// `node:sqlite` is stable from Node 23.5 onward. On Node 22.x it's gated
// behind `--experimental-sqlite` in early patches and unflagged-but-still-
// experimental in later ones; both paths produce an ExperimentalWarning, which
// we suppress before probing. Node < 22.5 lacks the module entirely and is
// rejected at startup by the `MIN_NODE_VERSION` check in `index.tsx`, so a
// re-exec'd child that still can't import means something unexpected (e.g.
// `--experimental-sqlite` removed in a future Node) and we surface that
// rather than loop.
export async function ensureNodeSqliteOrReexec(): Promise<ReexecResult> {
	suppressSqliteExperimentalWarning();
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
			// Suppress Node's "SQLite is an experimental feature" ProcessWarning
			// in the re-execed child. `--no-warnings=ExperimentalWarning` is not
			// a real flag (--no-warnings is a boolean); the documented name-filter
			// is --disable-warning=<name>, available since Node 21.3.
			"--disable-warning=ExperimentalWarning",
			...process.execArgv,
			selfPath,
			...process.argv.slice(2),
		],
		{ stdio: "inherit" },
	);
	return { action: "reexec", exitCode: result.status ?? 1 };
}
