import { cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	detectAndStripRoot,
	extractZip,
	inspectZip,
	pathExists,
} from "@/lib/archive.js";
import { stripControlChars } from "@/lib/sanitize.js";
import { detectCodevTools } from "@/lib/shims.js";
import {
	AGENT_LABELS,
	ALWAYS_AGENT,
	agentsServedBy,
	claudeFollowsSymlinks,
	isClaudeLink,
	isSkillAgent,
	type LinkMode,
	linkOrCopy,
	resolveTargets,
	type Scope,
	SKILL_AGENTS,
	type SkillAgent,
	safeSegment,
} from "@/lib/skill-dirs.js";
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

// Scope is now the only thing --here/--global choose; which agents get the
// skill is an orthogonal axis (see lib/skill-dirs.ts).
export type InstallLocation = Scope;

// One usage string for both entry points (dispatcher and non-interactive
// runner), so the flag list can't drift between them.
export const PULL_USAGE =
	"Usage: codevhub skill pull <name|id> [--here|--global|--dir <path>] [--agent <list>|--all-agents] [--force] [--json]";

export interface ParsedPull {
	target?: string;
	// Exact install root, verbatim from --dir: the skill lands in <dir>/<name>,
	// with no agent directories and no links. Mutually exclusive with `location`.
	dir?: string;
	// The picker's scope choice expressed as a flag (--here / --global).
	// Mutually exclusive with `dir`.
	location?: InstallLocation;
	// Explicit agent set from --agent/--all-agents. Absent ⇒ the caller picks the
	// default (defaultAgents()); the prompt uses it as the pre-check.
	agents?: SkillAgent[];
	force: boolean;
	json: boolean;
	error?: string;
}

// The set installed for when the user names none: CoDev Code always (the
// flagship agent is never opted out of), plus every other agent CoDev has
// actually configured on this machine. Used as both the prompt's pre-check and
// the non-interactive default, so CI never has to spell out --agent.
export function defaultAgents(): SkillAgent[] {
	const detected = new Set<string>(detectCodevTools());
	return SKILL_AGENTS.filter(
		(agent) => agent === ALWAYS_AGENT || detected.has(agent),
	);
}

// Parse a --agent value: comma-separated launch names, the same vocabulary
// `codevhub restore <agent>` accepts. CoDev Code is folded in whether or not it
// was named — it is not opt-out.
export function parseAgentList(value: string): SkillAgent[] | string {
	const names = value
		.split(",")
		.map((n) => n.trim())
		.filter((n) => n !== "");
	if (names.length === 0) return "Missing value for --agent.";
	const unknown = names.filter((n) => !isSkillAgent(n));
	if (unknown.length > 0) {
		return `Unknown agent: ${unknown.join(", ")}. Valid: ${SKILL_AGENTS.join(", ")}.`;
	}
	const chosen = new Set<SkillAgent>(names.filter(isSkillAgent));
	chosen.add(ALWAYS_AGENT);
	return SKILL_AGENTS.filter((agent) => chosen.has(agent));
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
	"--agent",
	"--all-agents",
]);

// Parse `pull` args: first non-flag token is the target (name|id); flags are
// --here/--global, --dir <path>, --agent/--all-agents, --force, --json. Shared
// by the interactive (index → app) and non-interactive (runSkillInstall) paths
// so parsing lives in one place.
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
	let agents: SkillAgent[] | undefined;
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--dir" || arg === "--agent") {
			// Consume the value here so it is never mistaken for a flag or a target,
			// whatever it contains.
			const value = args[++i];
			if (!value || value.startsWith("-")) {
				return { force, json, error: `Missing value for ${arg}.` };
			}
			if (arg === "--dir") {
				dir = value;
				continue;
			}
			const parsed = parseAgentList(value);
			if (typeof parsed === "string") return { force, json, error: parsed };
			agents = parsed;
			continue;
		}
		if (arg === "--all-agents") {
			agents = [...SKILL_AGENTS];
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
	// --dir is the raw escape hatch: one exact directory, no agent directories
	// and no links. An agent set would have nowhere to go.
	if (dir !== undefined && agents !== undefined) {
		return {
			force,
			json,
			error:
				"--dir installs to an exact path; it can't be combined with --agent.",
		};
	}
	return { target: positionals[0], dir, location, agents, force, json };
}

// Where one extraction landed, and which of the selected agents it serves.
// `mode` is reported verbatim so a copy is never described as a link.
export interface InstallPlacement {
	path: string;
	mode: LinkMode;
	agents: SkillAgent[];
}

export interface InstallResult {
	name: string;
	version?: string;
	id: string;
	// The single real extraction. Kept as `dir` so the --json shape stays
	// compatible with callers written against the single-directory install.
	dir: string;
	strippedRoot: string | null;
	placements: InstallPlacement[];
}

// Where an install should go: either one exact directory (--dir) or the agent
// directories resolved from a scope.
export type InstallTarget =
	| { kind: "dir"; rootDir: string }
	| { kind: "agents"; agents: SkillAgent[]; scope: Scope };

// Resolve where this install writes, and check every destination is safe BEFORE
// any filesystem work — especially before the rm() below, so a hostile hub name
// can never delete a directory outside the intended root.
function planPlacements(
	target: InstallTarget,
	name: string,
): { store: string; links: string[]; agents: SkillAgent[] } {
	if (target.kind === "dir") {
		return { store: safeSkillDir(target.rootDir, name), links: [], agents: [] };
	}
	// resolveTargets joins the name into two fixed roots, so validating the name
	// as a single path segment covers both destinations at once.
	if (!safeSegment(name)) {
		throw new Error(`Refusing to install skill with unsafe name "${name}".`);
	}
	const { store, links } = resolveTargets(target.agents, target.scope, name);
	return { store, links, agents: target.agents };
}

// Download + extract a skill whose metadata is already resolved. The install
// dir is named after the canonical skill name (meta.name), not the id or the
// ZIP's root folder — the root is only stripped so files aren't double-nested.
//
// The archive is extracted exactly once, into `store`; every other agent
// directory becomes a link to it (lib/skill-dirs.ts#linkOrCopy). A hub skill can
// run to thousands of files, so fanning out copies per agent is not free.
export async function installResolvedSkill(
	meta: SkillMeta,
	opts: { target: InstallTarget; force: boolean },
): Promise<InstallResult> {
	const plan = planPlacements(opts.target, meta.name);

	const zip = await downloadSkill(meta.id);
	// Vet the archive's size/entry counts before inflating or extracting it.
	inspectZip(zip);
	const { buffer, stripped } = detectAndStripRoot(zip);

	// Every destination is checked before anything is removed, so a refusal on
	// the second one can't leave the first already deleted.
	for (const dir of [plan.store, ...plan.links]) {
		if (!(await pathExists(dir))) continue;
		if (!opts.force) {
			throw new Error(
				`Already installed at ${dir}. Pass --force to overwrite.`,
			);
		}
	}
	for (const dir of [plan.store, ...plan.links]) {
		await rm(dir, { recursive: true, force: true });
	}

	await mkdir(plan.store, { recursive: true });
	await extractZip(buffer, plan.store);

	const placements: InstallPlacement[] = [
		{
			path: plan.store,
			mode: "store",
			agents: agentsFor(plan.store, opts.target, meta.name),
		},
	];
	for (const link of plan.links) {
		// Claude Code only follows a symlinked skill directory from v2.1.203; on an
		// older build the link reads as a file with no SKILL.md inside, so it has
		// to be a real copy.
		const mustCopy =
			opts.target.kind === "agents" &&
			isClaudeLink(link, opts.target.scope, meta.name) &&
			!(await claudeFollowsSymlinks());
		const mode = mustCopy
			? await copyInto(plan.store, link)
			: await linkOrCopy(plan.store, link);
		placements.push({
			path: link,
			mode,
			agents: agentsFor(link, opts.target, meta.name),
		});
	}

	return {
		name: meta.name,
		version: meta.version,
		id: meta.id,
		dir: plan.store,
		strippedRoot: stripped,
		placements,
	};
}

function agentsFor(
	path: string,
	target: InstallTarget,
	name: string,
): SkillAgent[] {
	if (target.kind === "dir") return [];
	return agentsServedBy(path, target.agents, target.scope, name);
}

async function copyInto(store: string, dest: string): Promise<LinkMode> {
	await cp(store, dest, { recursive: true });
	return "copy";
}

// Resolve <target> (id or name) to its canonical metadata, then download +
// extract. No console I/O — returns the result or throws. Used by the
// non-interactive runner; the Ink app resolves metadata itself (to show the
// name in the prompt) and calls installResolvedSkill directly.
export async function installSkill(
	target: string,
	opts: { target: InstallTarget; force: boolean },
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
			placements: r.placements,
		});
	}
	// Sanitize hub-sourced name/version for terminal display (paths are local and
	// already validated). JSON output above needs no scrubbing — stringify escapes
	// control characters.
	const name = stripControlChars(r.name);
	const versionSuffix = r.version ? `@${stripControlChars(r.version)}` : "";
	const served = r.placements.flatMap((p) => p.agents);
	// --dir installs for no particular agent, so it keeps the original one-liner.
	if (served.length === 0) {
		return `Installed ${name}${versionSuffix} -> ${r.dir}`;
	}
	const labels = SKILL_AGENTS.filter((a) => served.includes(a)).map(
		(a) => AGENT_LABELS[a],
	);
	const lines = [`Installed ${name}${versionSuffix} for ${labels.join(", ")}`];
	for (const placement of r.placements) {
		// Name the mechanism only when it isn't the real copy — and never call a
		// fallback copy a link.
		const suffix = placement.mode === "store" ? "" : ` (${placement.mode})`;
		lines.push(`  ${placement.path}${suffix}`);
	}
	return lines.join("\n");
}

// Non-interactive path (a location flag given, or piped/CI). The interactive
// prompt lives in SkillPullApp; here a location MUST be explicit, so no flag at
// all is an error rather than a silent default. The agent set does default
// though (defaultAgents()) — CI should not have to spell out --agent.
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
	// --dir is the escape hatch and is used verbatim; --here/--global resolve to
	// the selected agents' directories for that scope.
	const target: InstallTarget | null =
		parsed.dir !== undefined
			? { kind: "dir", rootDir: resolve(parsed.dir) }
			: parsed.location !== undefined
				? {
						kind: "agents",
						agents: parsed.agents ?? defaultAgents(),
						scope: parsed.location,
					}
				: null;
	if (target === null) {
		console.error(
			"Not a terminal — pass --here, --global, or --dir <path> to choose an install location.",
		);
		return 1;
	}

	try {
		const result = await installSkill(parsed.target, {
			target,
			force: parsed.force,
		});
		console.log(formatInstallResult(result, parsed.json));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
