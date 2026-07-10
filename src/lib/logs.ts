import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentTraceId } from "@/lib/log.js";
import { cliLogsDir } from "@/lib/paths.js";

// Reader side of the diagnostic log (`codevhub logs`). The writer is lib/log.ts;
// this module only consumes the NDJSON files it produces:
//   codevhub logs               pretty-print the most recent run
//   codevhub logs --path        print the newest log file's path
//   codevhub logs --trace <id>  print one run by trace id (prefix accepted)
//   codevhub logs --verbose     also print each document's codev.* context fields
//                            (the gateway api_key, endpoints, pids, …); composes
//                            with the bare and --trace modes
//
// Plain console output, no Ink — by the time someone reaches for this command
// something already went wrong, so it stays dependency- and ceremony-free.

interface DiagDoc {
	"@timestamp"?: string;
	log?: { level?: string };
	message?: string;
	service?: { name?: string; version?: string };
	trace?: { id?: string };
	// command + parent_trace_id are read explicitly; the index signature lets
	// --verbose enumerate the rest of the codev.* context (api_key, endpoint,
	// source, pid, …) without naming each field here.
	codev?: {
		command?: string;
		parent_trace_id?: string;
		[key: string]: unknown;
	};
	event?: { outcome?: string };
	error?: { message?: string };
}

// --verbose renders codev.* context values as indented ↳ lines. Primitives
// print bare; the defensive JSON.stringify covers any nested object a future
// field might carry.
function formatExtra(value: unknown): string {
	if (value === null || typeof value !== "object") return String(value);
	return JSON.stringify(value);
}

// Mirror initLogging's directory resolution so the reader always looks where
// the writer wrote.
function diagDir(): string {
	return process.env.CODEV_LOG_DIR || cliLogsDir();
}

// Full paths of the diagnostic files, oldest → newest. The fixed
// codev-YYYYMMDD.ndjson name makes the filename sort chronological.
function listLogFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => /^codev-\d{8}\.ndjson$/.test(name))
			.sort()
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

// All documents across the given files, in write order. Malformed lines (a
// crash mid-append, manual editing) are skipped rather than fatal — the whole
// point of this command is reading evidence after something went wrong.
function readAllDocs(paths: string[]): DiagDoc[] {
	const docs: DiagDoc[] = [];
	for (const path of paths) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf-8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				docs.push(JSON.parse(line) as DiagDoc);
			} catch {
				// Skip malformed line.
			}
		}
	}
	return docs;
}

function printRun(run: DiagDoc[], allDocs: DiagDoc[], verbose = false): void {
	const first = run[0];
	const traceId = first?.trace?.id ?? "?";
	const command = first?.codev?.command ?? "?";
	const startedAt = first?.["@timestamp"] ?? "?";
	// The codev version that produced the run — the first thing to check when a
	// bug report's behavior doesn't match current source (e.g. a since-fixed
	// path-encoding issue). Every doc carries it via service.version.
	const version = first?.service?.version;
	const versionTag = version ? ` v${version}` : "";
	console.log(
		`Run ${traceId} — codevhub ${command}${versionTag} — ${startedAt}`,
	);
	console.log("");
	for (const doc of run) {
		// "HH:MM:SS.mmm" from the ISO timestamp; dates are in the header/file.
		const time = (doc["@timestamp"] ?? "").slice(11, 23).padEnd(12);
		const level = (doc.log?.level ?? "?").toUpperCase().padEnd(5);
		console.log(`${time} ${level} ${doc.message ?? ""}`);
		// Most messages embed their context; surface error.message only when it
		// adds something the message line doesn't already say.
		if (doc.error?.message && doc.error.message !== doc.message) {
			console.log(`${" ".repeat(19)}↳ ${doc.error.message}`);
		}
		// --verbose: surface the per-document codev.* context the compact view
		// hides — the gateway api_key (the one cleartext secret), plus endpoints,
		// sources, pids, and any field added later. command and parent_trace_id
		// are structural (shown in the header/footer), so skip them.
		if (verbose && doc.codev) {
			for (const [key, value] of Object.entries(doc.codev)) {
				if (key === "command" || key === "parent_trace_id") continue;
				if (value === undefined) continue;
				console.log(`${" ".repeat(19)}↳ ${key}=${formatExtra(value)}`);
			}
		}
	}
	// Child processes (re-exec, upload daemon) log under their own trace with
	// codev.parent_trace_id pointing back here — surface them so the chain is
	// followable.
	const children = [
		...new Set(
			allDocs
				.filter((d) => d.codev?.parent_trace_id === traceId)
				.map((d) => d.trace?.id)
				.filter((id): id is string => !!id),
		),
	];
	if (children.length > 0) {
		console.log("");
		for (const child of children) {
			console.log(
				`Child run ${child} — view with: codevhub logs --trace ${child}`,
			);
		}
	}
}

export function runLogs(args: string[]): number {
	let showPath = false;
	let verbose = false;
	let trace: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path") {
			showPath = true;
		} else if (arg === "--verbose") {
			verbose = true;
		} else if (arg === "--trace") {
			trace = args[++i] ?? null;
			if (!trace) {
				console.error("--trace requires a trace id (prefix accepted).");
				return 1;
			}
		} else {
			console.error(`Unknown option: ${arg}`);
			console.error("Usage: codevhub logs [--path | --trace <id>] [--verbose]");
			return 1;
		}
	}

	const dir = diagDir();
	const files = listLogFiles(dir);
	if (files.length === 0) {
		console.error(`No diagnostic logs found in ${dir}.`);
		return 1;
	}

	if (showPath) {
		console.log(files[files.length - 1]);
		return 0;
	}

	const docs = readAllDocs(files);

	if (trace) {
		const wanted = trace;
		const matches = docs.filter((d) => d.trace?.id?.startsWith(wanted));
		const ids = [
			...new Set(
				matches.map((d) => d.trace?.id).filter((id): id is string => !!id),
			),
		];
		if (ids.length === 0) {
			console.error(`No documents for trace ${wanted}.`);
			return 1;
		}
		if (ids.length > 1) {
			console.error(`Trace prefix ${wanted} is ambiguous:`);
			for (const id of ids) console.error(`  ${id}`);
			return 1;
		}
		printRun(matches, docs, verbose);
		return 0;
	}

	// Bare mode: the most recent run that is neither this very invocation nor
	// a previous `codevhub logs` (showing the log viewer's own runs would bury
	// the run the user actually cares about). Prefer top-level runs: a child
	// process (upload daemon, sqlite re-exec) writes after its parent and
	// would otherwise always win, but the run the user invoked is the parent —
	// children stay reachable via the footer. Fall back to a child run only
	// when no top-level run exists at all (e.g. the parent's file was pruned).
	const own = currentTraceId();
	const pick = (allowChildren: boolean): string | null => {
		for (let i = docs.length - 1; i >= 0; i--) {
			const doc = docs[i];
			const id = doc?.trace?.id;
			if (!id || id === own) continue;
			if (doc?.codev?.command === "logs") continue;
			if (!allowChildren && doc?.codev?.parent_trace_id) continue;
			return id;
		}
		return null;
	};
	const target = pick(false) ?? pick(true);
	if (!target) {
		console.error("No prior runs recorded.");
		return 1;
	}
	printRun(
		docs.filter((d) => d.trace?.id === target),
		docs,
		verbose,
	);
	return 0;
}
