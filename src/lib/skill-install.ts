import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	detectAndStripRoot,
	extractZip,
	inspectZip,
	pathExists,
} from "@/lib/archive.js";
import { stripControlChars } from "@/lib/sanitize.js";
import { downloadSkill, getSkillMeta, type SkillMeta } from "@/lib/skillhub.js";

// The server's skill name becomes a directory under rootDir. Never trust it as
// a path: require it to resolve to a single direct child of rootDir, rejecting
// path separators, "..", and absolute paths. Without this, a hostile hub entry
// named e.g. "../../../tmp/x" could write outside the skills dir — or, combined
// with --force, delete an arbitrary directory via rm().
function safeSkillDir(rootDir: string, name: string): string {
	const root = resolve(rootDir);
	const dir = resolve(root, name);
	const rel = relative(root, dir);
	if (
		rel === "" ||
		rel.startsWith("..") ||
		isAbsolute(rel) ||
		rel.includes(sep)
	) {
		throw new Error(`Refusing to install skill with unsafe name "${name}".`);
	}
	return dir;
}

export type InstallLocation = "current" | "global";

// One usage string for both entry points (dispatcher and non-interactive
// runner), so the flag list can't drift between them.
export const PULL_USAGE =
	"Usage: codevhub skill pull <name|id> [--here|--global|--dir <path>] [--force] [--json]";

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
	// Exact install root, verbatim from --dir: the skill lands in <dir>/<name>,
	// with no `.claude/skills` segment added. Mutually exclusive with `location`.
	dir?: string;
	// The picker's choice expressed as a flag (--here / --global), resolved
	// through skillsDirFor. Mutually exclusive with `dir`.
	location?: InstallLocation;
	force: boolean;
	json: boolean;
	error?: string;
}

// Every flag `pull` accepts. Anything else starting with "-" is a typo, and is
// rejected rather than ignored — a silently dropped `--forse` looks like a
// successful run that just didn't do what was asked.
//
// Deliberately no `-f` alias, for the same reason `restore --force` has none:
// `-f` elsewhere in this CLI (`login`, `upload`, `doctor`) forces a fresh login,
// which costs nothing, while here the identical keystroke is an `rm -rf` of a
// skill directory that may hold local edits. The reflex must not reach it.
const PULL_FLAGS = new Set([
	"--dir",
	"--force",
	"--json",
	"--here",
	"--global",
]);

// Parse `pull` args: first non-flag token is the target (name|id); flags are
// --here/--global, --dir <path>, --force, --json. Shared by the interactive
// (index → app) and non-interactive (runSkillInstall) paths so parsing lives in
// one place.
export function parsePullArgs(args: string[]): ParsedPull {
	const force = args.includes("--force");
	const json = args.includes("--json");

	const here = args.includes("--here");
	const global = args.includes("--global");
	if (here && global) {
		return { force, json, error: "Pass either --here or --global, not both." };
	}
	const location: InstallLocation | undefined = here
		? "current"
		: global
			? "global"
			: undefined;

	let dir: string | undefined;
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--dir") {
			// Consume the value here so it is never mistaken for a flag or a target,
			// whatever it contains.
			const value = args[++i];
			if (!value || value.startsWith("-")) {
				return { force, json, error: "Missing value for --dir." };
			}
			dir = value;
			continue;
		}
		if (arg.startsWith("-")) {
			if (!PULL_FLAGS.has(arg)) {
				return { force, json, error: `Unknown flag: ${arg}` };
			}
			continue;
		}
		positionals.push(arg);
	}

	if (dir !== undefined && location !== undefined) {
		return {
			force,
			json,
			error: "Pass either --dir or --here/--global, not both.",
		};
	}
	return { target: positionals[0], dir, location, force, json };
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
	// Validate the target path before any filesystem work (especially before the
	// rm() below), so an unsafe server name can never write to — or delete — a
	// location outside rootDir.
	const skillDir = safeSkillDir(opts.rootDir, meta.name);

	const zip = await downloadSkill(meta.id);
	// Vet the archive's size/entry counts before inflating or extracting it.
	inspectZip(zip);
	const { buffer, stripped } = detectAndStripRoot(zip);

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
	// Sanitize hub-sourced name/version for terminal display (dir is a local,
	// already-validated path). JSON output above needs no scrubbing — stringify
	// escapes control characters.
	const name = stripControlChars(r.name);
	const versionSuffix = r.version ? `@${stripControlChars(r.version)}` : "";
	return `Installed ${name}${versionSuffix} -> ${r.dir}`;
}

// Non-interactive path (a location flag given, or piped/CI). The interactive
// prompt lives in SkillPullApp; here a location MUST be explicit, so no flag at
// all is an error rather than a silent default. Returns the exit code.
export async function runSkillInstall(args: string[]): Promise<number> {
	const parsed = parsePullArgs(args);
	if (parsed.error) {
		console.error(parsed.error);
		return 1;
	}
	if (!parsed.target) {
		console.error(PULL_USAGE);
		return 1;
	}
	// --here/--global reproduce the picker's two choices (and so append
	// `.claude/skills`); --dir is the escape hatch and is used verbatim.
	const rootDir =
		parsed.dir !== undefined
			? resolve(parsed.dir)
			: parsed.location !== undefined
				? skillsDirFor(parsed.location)
				: null;
	if (rootDir === null) {
		console.error(
			"Not a terminal — pass --here, --global, or --dir <path> to choose an install location.",
		);
		return 1;
	}

	try {
		const result = await installSkill(parsed.target, {
			rootDir,
			force: parsed.force,
		});
		console.log(formatInstallResult(result, parsed.json));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
