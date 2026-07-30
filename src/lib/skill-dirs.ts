import { cp, mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execAsync } from "@/lib/npm.js";

// Where each agent looks for skills, and how one extracted copy is made to serve
// several of them.
//
// Established by reading the agents themselves rather than their docs — the
// tables inside the CoDev Code bundle list only the `~/…` paths and omit the
// project-scope walk, which is the opposite of what the code does
// (`packages/opencode/src/skill/index.ts#discoverSkills`):
//
//     externalDirs = [".claude", ".agents"]
//     for (const dir of externalDirs)                  // GLOBAL: <home>/<dir>
//       scan(join(global.home, dir), "skills/**|SKILL.md", { dot: true })
//     for (const root of up({ targets: externalDirs,   // PROJECT: cwd → worktree
//                             start: directory, stop: worktree }))
//       scan(root, "skills/**|SKILL.md", { dot: true })
//
// So CoDev Code and OpenCode read BOTH `.claude/skills` and `.agents/skills`, at
// BOTH scopes. Codex reads only `.agents/skills` (also cwd → repo root, plus
// `$HOME`); Claude Code reads only `.claude/skills`. Two directories therefore
// cover all four agents, and no agent needs a directory of its own.

export const SKILL_AGENTS = ["claude", "codex", "opencode", "codev"] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

export function isSkillAgent(value: string): value is SkillAgent {
	return (SKILL_AGENTS as readonly string[]).includes(value);
}

// CoDev Code is the flagship agent and is always installed for — it is never
// absent from a target set, and the picker renders it as locked.
export const ALWAYS_AGENT: SkillAgent = "codev";

export const AGENT_LABELS: Record<SkillAgent, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	codev: "CoDev Code",
};

export type Scope = "current" | "global";

// The two directories, relative to a scope root.
const CLAUDE_DIR = join(".claude", "skills");
const AGENTS_DIR = join(".agents", "skills");

// Which agents read which directory. Both scopes use the same rule.
const READS_AGENTS_DIR: Record<SkillAgent, boolean> = {
	codex: true,
	codev: true,
	opencode: true,
	claude: false,
};
const READS_CLAUDE_DIR: Record<SkillAgent, boolean> = {
	codex: false,
	codev: true,
	opencode: true,
	claude: true,
};

export function scopeRoot(scope: Scope): string {
	return scope === "current" ? process.cwd() : homedir();
}

// How a link target was actually produced. `store` is the real extraction; the
// rest describe a second path pointing at it. Reported verbatim so a copy is
// never described as a link.
export type LinkMode = "store" | "symlink" | "junction" | "copy";

export interface SkillTargets {
	// Absolute path the archive is extracted into — the single real copy.
	store: string;
	// Absolute paths that must end up pointing at `store`.
	links: string[];
}

// Pick the directory covering the most selected agents as the store, then link
// the other one only if some selected agent can't reach the store.
//
// The asymmetry is deliberate: when Codex isn't selected, `.claude/skills` alone
// serves every remaining agent, so only one directory is created and CoDev
// Code/OpenCode never see the skill twice. Adding Codex is what forces the
// second directory into existence.
export function resolveTargets(
	agents: readonly SkillAgent[],
	scope: Scope,
	name: string,
): SkillTargets {
	const root = scopeRoot(scope);
	const claudePath = join(root, CLAUDE_DIR, name);
	const agentsPath = join(root, AGENTS_DIR, name);

	const needsAgentsDir = agents.some((a) => !READS_CLAUDE_DIR[a]);
	if (!needsAgentsDir) return { store: claudePath, links: [] };

	const needsClaudeDir = agents.some((a) => !READS_AGENTS_DIR[a]);
	return {
		store: agentsPath,
		links: needsClaudeDir ? [claudePath] : [],
	};
}

// Which selected agents a given path serves — so the result can say what each
// agent got rather than printing bare directories.
export function agentsServedBy(
	path: string,
	agents: readonly SkillAgent[],
	scope: Scope,
	name: string,
): SkillAgent[] {
	const root = scopeRoot(scope);
	const isClaudeDir = path === join(root, CLAUDE_DIR, name);
	const table = isClaudeDir ? READS_CLAUDE_DIR : READS_AGENTS_DIR;
	return agents.filter((a) => table[a]);
}

// Stubbable indirection, same idiom as tlsApi / httpApi / spawner: the fallback
// chain below is chosen by whether these throw, which no test could otherwise
// provoke on a machine where symlinks work.
export const linkApi = {
	symlink,
	cp,
};

// Point `linkPath` at `store`, degrading rather than failing:
//
//  1. A RELATIVE symlink. This repo's own skill is wired exactly this way
//     (`.claude/skills/vercel-react-best-practices ->
//     ../../.agents/skills/vercel-react-best-practices`, committed as git mode
//     120000), and relative is what survives `git clone` — an absolute link
//     would break in every other checkout.
//  2. A Windows junction. Unlike a Windows symlink it needs neither Developer
//     Mode nor administrator rights, which is what makes this viable for the
//     Git Bash audience. Junctions resolve only absolute targets, so a
//     project-scope junction isn't meaningfully committable — a Windows-only
//     degradation, not a regression.
//  3. A recursive copy, reported as such.
export async function linkOrCopy(
	store: string,
	linkPath: string,
): Promise<LinkMode> {
	await mkdir(join(linkPath, ".."), { recursive: true });
	const target = relativeTarget(store, linkPath);

	try {
		await linkApi.symlink(target, linkPath, "dir");
		return "symlink";
	} catch {
		// fall through
	}
	if (process.platform === "win32") {
		try {
			await linkApi.symlink(resolve(store), linkPath, "junction");
			return "junction";
		} catch {
			// fall through
		}
	}
	await linkApi.cp(store, linkPath, { recursive: true });
	return "copy";
}

// The link body: `store` expressed relative to the directory holding the link.
// Falls back to an absolute target only when the two share no common root
// (different Windows volumes), where a relative path cannot be formed at all.
function relativeTarget(store: string, linkPath: string): string {
	const from = join(linkPath, "..");
	const rel = relative(resolve(from), resolve(store));
	if (!rel || isAbsolute(rel)) return resolve(store);
	return rel;
}

// Claude Code follows a symlinked skill directory only from v2.1.203 — earlier
// versions read the link as a plain file and find no SKILL.md. Below the floor
// the Claude link has to be a real copy, so probe before linking.
const CLAUDE_SYMLINK_FLOOR = [2, 1, 203] as const;

export async function claudeFollowsSymlinks(): Promise<boolean> {
	const r = await execAsync("claude", ["--version"]);
	if (r.error) return false;
	const parsed = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
	if (!parsed) return false;
	const version = [
		Number(parsed[1]),
		Number(parsed[2]),
		Number(parsed[3]),
	] as const;
	for (let i = 0; i < CLAUDE_SYMLINK_FLOOR.length; i++) {
		const have = version[i] ?? 0;
		const need = CLAUDE_SYMLINK_FLOOR[i] ?? 0;
		if (have !== need) return have > need;
	}
	return true;
}

// True when `linkPath` is the Claude directory — the only link whose mechanism
// depends on the agent's version.
export function isClaudeLink(
	linkPath: string,
	scope: Scope,
	name: string,
): boolean {
	return linkPath === join(scopeRoot(scope), CLAUDE_DIR, name);
}

// Guard the skill name the same way skill-install does before it becomes a path
// segment under either directory. Exported so callers validate once and both
// target paths inherit it.
export function safeSegment(name: string): boolean {
	return (
		name !== "" &&
		!name.startsWith(".") &&
		!name.includes(sep) &&
		!name.includes("/") &&
		!isAbsolute(name)
	);
}
