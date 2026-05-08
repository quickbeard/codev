import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@/providers/types.js";

export function codevLogsDir(): string {
	return join(homedir(), ".codev", "logs");
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
	if (real.startsWith(`${home}/`)) {
		stripped = real.slice(home.length + 1);
	}
	const mangled = stripped
		.replace(/[^a-zA-Z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return mangled || "home";
}

export function projectLogsDir(cwd: string): string {
	return join(codevLogsDir(), projectFolderName(cwd));
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
