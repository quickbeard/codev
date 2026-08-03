import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Session } from "@/providers/types.js";

// Conversation exports (the data `codevhub upload` ships). Lived at
// ~/.codev-hub/logs/ before the CLI grew its own diagnostics — that path now
// belongs to cliLogsDir, and runExport migrates legacy project folders over.
export function agentLogsDir(): string {
	return join(homedir(), ".codev-hub", "agent-logs");
}

// CoDev's own diagnostic logs (ECS NDJSON, one codev-YYYYMMDD.ndjson per day —
// see lib/log.ts). Kept separate from agentLogsDir so self-logs and
// conversation exports can't mix.
export function cliLogsDir(): string {
	return join(homedir(), ".codev-hub", "logs");
}

// Where `codevhub skill office` stages the offline bundle + setup script
// (up to ~1.1GB). Kept between runs so a re-run resumes an interrupted
// download or verifies the existing files instead of re-downloading.
export function officeDownloadsDir(): string {
	return join(homedir(), ".codev-hub", "office");
}

// The machine-readable result of the last `codevhub doctor` run. Deliberately a
// single file rather than a dated series: it is a snapshot of "how is this
// machine right now", and a stale one is worse than none when someone attaches
// it to a support ticket. Every run replaces it.
export function doctorReportPath(): string {
	return join(homedir(), ".codev-hub", "doctor-report.json");
}

// Maps a working directory to a per-project subfolder name. Strips the user's
// home prefix so the folder is shorter, replaces non-alphanumeric chars with
// dashes, then collapses runs of dashes and trims them. Falls back to "home"
// when the cwd is exactly the home dir.
export function projectFolderName(cwd: string): string {
	let real: string;
	try {
		real = realpathSync(cwd);
	} catch {
		real = cwd;
	}
	const home = homedir();
	if (real === home) {
		return "home";
	}
	let stripped = real;
	// Use node:path.sep so Windows (`\`) and POSIX (`/`) both match. Hard-coded
	// `/` skipped the strip on Windows and left the drive letter in the mangled
	// output.
	if (real.startsWith(`${home}${sep}`)) {
		stripped = real.slice(home.length + 1);
	}
	const mangled = stripped
		.replace(/[^a-zA-Z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return mangled || "home";
}

export function projectLogsDir(cwd: string): string {
	return join(agentLogsDir(), projectFolderName(cwd));
}

// YYYY-MM-DD_HH-MM-SSZ — UTC, filesystem-safe, sortable.
export function formatUtcTimestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const yyyy = date.getUTCFullYear();
	const mm = pad(date.getUTCMonth() + 1);
	const dd = pad(date.getUTCDate());
	const hh = pad(date.getUTCHours());
	const mi = pad(date.getUTCMinutes());
	const ss = pad(date.getUTCSeconds());
	return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}Z`;
}

export function buildFilename(session: Session): string {
	const ts = formatUtcTimestamp(session.createdAt);
	const slug = generateSlug(session.firstUserMessage ?? "");
	return slug ? `${ts}-${slug}.md` : `${ts}.md`;
}

// Lowercases, strips Unicode marks, swaps a few common symbols for words,
// drops other punctuation, takes the first 4 tokens, joins with `-`. Mirrors
// vtnet's GenerateFilenameFromUserMessage so filenames feel consistent.
export function generateSlug(message: string): string {
	if (!message) return "";
	const normalized = message
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/@/g, " at ")
		.replace(/&/g, " and ")
		.replace(/#/g, " hash ")
		.replace(/[^a-z0-9\s]+/g, " ");
	const words = normalized.split(/\s+/).filter(Boolean).slice(0, 4);
	if (words.length === 0) return "";
	return words
		.join("-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}
