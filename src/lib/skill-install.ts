import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectAndStripRoot, extractZip, pathExists } from "@/lib/archive.js";
import { downloadSkill, listHubSkills } from "@/lib/skillhub.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InstallLocation = "current" | "global";

// Root dir for each prompt choice. "current" is cwd-relative (created if
// missing on install); "global" is the home skills dir. Claude Agent Skills
// live under `.claude/skills` in both cases.
export function skillsDirFor(location: InstallLocation): string {
	return location === "current"
		? join(process.cwd(), ".claude", "skills")
		: join(homedir(), ".claude", "skills");
}

export interface ParsedPull {
	target?: string;
	dir?: string;
	force: boolean;
	json: boolean;
	error?: string;
}

// Parse `pull` args: first non-flag token is the target (name|id); flags are
// --dir <path>, --force/-f, --json. Shared by the interactive (index → app) and
// non-interactive (runSkillInstall) paths so parsing lives in one place.
export function parsePullArgs(args: string[]): ParsedPull {
	const force = args.includes("--force") || args.includes("-f");
	const json = args.includes("--json");

	let dir: string | undefined;
	const dirIdx = args.indexOf("--dir");
	if (dirIdx !== -1) {
		const value = args[dirIdx + 1];
		if (!value || value.startsWith("-")) {
			return { force, json, error: "Missing value for --dir." };
		}
		dir = value;
	}

	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--dir") {
			i++; // skip its value
			continue;
		}
		if (args[i]?.startsWith("-")) continue;
		positionals.push(args[i] as string);
	}
	return { target: positionals[0], dir, force, json };
}

export interface InstallResult {
	name: string;
	version?: string;
	id: string;
	dir: string;
	strippedRoot: string | null;
}

interface SkillPayload {
	buffer: Buffer;
	name: string;
	id: string;
	version?: string;
	strippedRoot: string | null;
}

// Core install: resolve <target>, download, un-nest, and extract into
// <rootDir>/<name>. No console I/O — returns the result or throws. Shared by the
// Ink app and the non-interactive runner.
export async function installSkill(
	target: string,
	opts: { rootDir: string; force: boolean },
): Promise<InstallResult> {
	const payload = await resolveAndDownload(target);
	const skillDir = join(opts.rootDir, payload.name);

	if (await pathExists(skillDir)) {
		if (!opts.force) {
			throw new Error(
				`Already installed at ${skillDir}. Pass --force to overwrite.`,
			);
		}
		await rm(skillDir, { recursive: true, force: true });
	}

	await mkdir(skillDir, { recursive: true });
	await extractZip(payload.buffer, skillDir);

	return {
		name: payload.name,
		version: payload.version,
		id: payload.id,
		dir: skillDir,
		strippedRoot: payload.strippedRoot,
	};
}

export function formatInstallResult(r: InstallResult, json: boolean): string {
	if (json) {
		return JSON.stringify({
			ok: true,
			name: r.name,
			version: r.version ?? null,
			id: r.id,
			dir: r.dir,
			strippedRoot: r.strippedRoot,
		});
	}
	const versionSuffix = r.version ? `@${r.version}` : "";
	return `Installed ${r.name}${versionSuffix} -> ${r.dir}`;
}

// Non-interactive path (`--dir` given, or piped/CI). The interactive
// location prompt lives in SkillPullApp; here a location MUST be explicit, so a
// missing --dir is an error rather than a silent default. Returns the exit code.
export async function runSkillInstall(args: string[]): Promise<number> {
	const parsed = parsePullArgs(args);
	if (parsed.error) {
		console.error(parsed.error);
		return 1;
	}
	if (!parsed.target) {
		console.error(
			"Usage: codev skill pull <name|id> [--dir <path>] [--force] [--json]",
		);
		return 1;
	}
	if (!parsed.dir) {
		console.error(
			"Not a terminal — pass --dir <path> to choose an install location.",
		);
		return 1;
	}

	try {
		const result = await installSkill(parsed.target, {
			rootDir: resolve(parsed.dir),
			force: parsed.force,
		});
		console.log(formatInstallResult(result, parsed.json));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

// Resolve <target> (UUID → download directly; name → exact match from the hub
// listing) and download + un-nest the ZIP.
async function resolveAndDownload(target: string): Promise<SkillPayload> {
	if (UUID_RE.test(target)) {
		const zip = await downloadSkill(target);
		const { buffer, stripped } = detectAndStripRoot(zip);
		// The ZIP's root folder names the skill; fall back to the id if unstripped.
		return {
			buffer,
			name: stripped ?? target,
			id: target,
			version: undefined,
			strippedRoot: stripped,
		};
	}

	const { items } = await listHubSkills({ search: target, limit: 50 });
	const skill = items.find((s) => s.name === target);
	if (!skill) {
		const near = items
			.map((s) => s.name)
			.slice(0, 5)
			.join(", ");
		throw new Error(
			`No public skill named "${target}".${near ? ` Did you mean: ${near}?` : ""}`,
		);
	}

	const zip = await downloadSkill(skill.id);
	const { buffer, stripped } = detectAndStripRoot(zip);
	return {
		buffer,
		name: skill.name,
		id: skill.id,
		version: skill.version,
		strippedRoot: stripped,
	};
}
