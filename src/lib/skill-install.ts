import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectAndStripRoot, extractZip, pathExists } from "@/lib/archive.js";
import { downloadSkill, getSkillMeta, type SkillMeta } from "@/lib/skillhub.js";

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

// Download + extract a skill whose metadata is already resolved. The install
// dir is named after the canonical skill name (meta.name), not the id or the
// ZIP's root folder — the root is only stripped so files aren't double-nested.
export async function installResolvedSkill(
	meta: SkillMeta,
	opts: { rootDir: string; force: boolean },
): Promise<InstallResult> {
	const zip = await downloadSkill(meta.id);
	const { buffer, stripped } = detectAndStripRoot(zip);
	const skillDir = join(opts.rootDir, meta.name);

	if (await pathExists(skillDir)) {
		if (!opts.force) {
			throw new Error(
				`Already installed at ${skillDir}. Pass --force to overwrite.`,
			);
		}
		await rm(skillDir, { recursive: true, force: true });
	}

	await mkdir(skillDir, { recursive: true });
	await extractZip(buffer, skillDir);

	return {
		name: meta.name,
		version: meta.version,
		id: meta.id,
		dir: skillDir,
		strippedRoot: stripped,
	};
}

// Resolve <target> (id or name) to its canonical metadata, then download +
// extract. No console I/O — returns the result or throws. Used by the
// non-interactive runner; the Ink app resolves metadata itself (to show the
// name in the prompt) and calls installResolvedSkill directly.
export async function installSkill(
	target: string,
	opts: { rootDir: string; force: boolean },
): Promise<InstallResult> {
	const meta = await getSkillMeta(target);
	return installResolvedSkill(meta, opts);
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

// Non-interactive path (`--dir` given, or piped/CI). The interactive location
// prompt lives in SkillPullApp; here a location MUST be explicit, so a missing
// --dir is an error rather than a silent default. Returns the exit code.
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
