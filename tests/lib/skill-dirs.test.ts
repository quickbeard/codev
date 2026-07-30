import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as npm from "@/lib/npm.js";
import {
	agentsServedBy,
	claudeFollowsSymlinks,
	isClaudeLink,
	linkApi,
	linkOrCopy,
	resolveTargets,
	type SkillAgent,
	safeSegment,
} from "@/lib/skill-dirs.js";

let tempHome: string;
let tempCwd: string;

const CLAUDE = join(".claude", "skills");
const AGENTS = join(".agents", "skills");

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "codev-skill-dirs-home-"));
	tempCwd = mkdtempSync(join(tmpdir(), "codev-skill-dirs-cwd-"));
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// never touch the real home directory.
	vi.stubEnv("HOME", tempHome);
	vi.stubEnv("USERPROFILE", tempHome);
	vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempHome, { recursive: true, force: true });
	rmSync(tempCwd, { recursive: true, force: true });
});

// Which directory each agent reads was established from the agents' own source
// (see the header of lib/skill-dirs.ts). These pin the consequence: whichever
// directory covers the most selected agents becomes the single real copy.
describe("resolveTargets", () => {
	test("without Codex, .claude/skills alone serves every agent", () => {
		for (const agents of [
			["codev"],
			["codev", "claude"],
			["codev", "opencode"],
			["claude", "codev", "opencode"],
		] as SkillAgent[][]) {
			const t = resolveTargets(agents, "global", "pg-tuner");
			expect(t.store).toBe(join(tempHome, CLAUDE, "pg-tuner"));
			// One directory, so CoDev Code and OpenCode never see the skill twice.
			expect(t.links).toEqual([]);
		}
	});

	test("Codex without Claude Code needs only .agents/skills", () => {
		const t = resolveTargets(["codev", "codex"], "global", "pg-tuner");
		expect(t.store).toBe(join(tempHome, AGENTS, "pg-tuner"));
		expect(t.links).toEqual([]);
	});

	test("Codex plus Claude Code is the only case needing two directories", () => {
		const t = resolveTargets(
			["claude", "codex", "codev"],
			"global",
			"pg-tuner",
		);
		expect(t.store).toBe(join(tempHome, AGENTS, "pg-tuner"));
		expect(t.links).toEqual([join(tempHome, CLAUDE, "pg-tuner")]);
	});

	test("scope only changes the root — the rule is identical", () => {
		const global = resolveTargets(["claude", "codex"], "global", "x");
		const current = resolveTargets(["claude", "codex"], "current", "x");
		expect(global.store).toBe(join(tempHome, AGENTS, "x"));
		expect(current.store).toBe(join(tempCwd, AGENTS, "x"));
		expect(current.links).toEqual([join(tempCwd, CLAUDE, "x")]);
	});
});

describe("agentsServedBy", () => {
	test("reports every selected agent that reads a given directory", () => {
		const agents: SkillAgent[] = ["claude", "codex", "codev"];
		const store = join(tempHome, AGENTS, "x");
		const link = join(tempHome, CLAUDE, "x");
		// .agents/skills is read by Codex, CoDev Code and OpenCode — not Claude.
		expect(agentsServedBy(store, agents, "global", "x")).toEqual([
			"codex",
			"codev",
		]);
		// .claude/skills is read by Claude Code, CoDev Code and OpenCode.
		expect(agentsServedBy(link, agents, "global", "x")).toEqual([
			"claude",
			"codev",
		]);
	});
});

describe("linkOrCopy", () => {
	function makeStore(): string {
		const store = join(tempHome, AGENTS, "pg-tuner");
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "SKILL.md"), "# pg-tuner");
		return store;
	}

	test("creates a relative symlink that resolves to the store", async () => {
		const store = makeStore();
		const link = join(tempHome, CLAUDE, "pg-tuner");

		const mode = await linkOrCopy(store, link);

		expect(mode).toBe("symlink");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		// Relative, not absolute — this repo's own skill is wired the same way and
		// committed as git mode 120000, which only survives a clone if relative.
		const target = readlinkSync(link);
		expect(isAbsolute(target)).toBe(false);
		expect(target).toContain("..");
		// And it actually resolves.
		expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner");
	});

	test("falls back to a copy when symlinking fails, and says so", async () => {
		const store = makeStore();
		const link = join(tempHome, CLAUDE, "pg-tuner");
		vi.spyOn(linkApi, "symlink").mockRejectedValue(
			Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
		);

		const mode = await linkOrCopy(store, link);

		// Reported as a copy — never described as a link it isn't.
		expect(mode).toBe("copy");
		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner");
	});

	test("creates the parent directory when the agent has never been used", async () => {
		const store = makeStore();
		const link = join(tempHome, CLAUDE, "pg-tuner");
		expect(existsSync(join(tempHome, CLAUDE))).toBe(false);

		await linkOrCopy(store, link);

		expect(existsSync(link)).toBe(true);
	});
});

describe("claudeFollowsSymlinks", () => {
	function version(stdout: string) {
		return vi
			.spyOn(npm, "execAsync")
			.mockResolvedValue({ error: null, stdout, stderr: "" });
	}

	test("true at and above the 2.1.203 floor", async () => {
		version("2.1.203 (Claude Code)");
		expect(await claudeFollowsSymlinks()).toBe(true);
		version("2.1.220 (Claude Code)");
		expect(await claudeFollowsSymlinks()).toBe(true);
		version("3.0.0 (Claude Code)");
		expect(await claudeFollowsSymlinks()).toBe(true);
	});

	test("false below it, so the Claude link becomes a real copy", async () => {
		version("2.1.202 (Claude Code)");
		expect(await claudeFollowsSymlinks()).toBe(false);
		version("2.0.999 (Claude Code)");
		expect(await claudeFollowsSymlinks()).toBe(false);
	});

	test("false when claude is absent or unparseable", async () => {
		vi.spyOn(npm, "execAsync").mockResolvedValue({
			error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			stdout: "",
			stderr: "",
		});
		expect(await claudeFollowsSymlinks()).toBe(false);

		version("some unexpected banner");
		expect(await claudeFollowsSymlinks()).toBe(false);
	});
});

describe("isClaudeLink", () => {
	test("identifies the one link whose mechanism depends on a version", () => {
		expect(isClaudeLink(join(tempHome, CLAUDE, "x"), "global", "x")).toBe(true);
		expect(isClaudeLink(join(tempHome, AGENTS, "x"), "global", "x")).toBe(
			false,
		);
	});
});

describe("safeSegment", () => {
	test("rejects anything that would escape a skills directory", () => {
		expect(safeSegment("pg-tuner")).toBe(true);
		expect(safeSegment("..")).toBe(false);
		expect(safeSegment("../evil")).toBe(false);
		expect(safeSegment("nested/name")).toBe(false);
		expect(safeSegment("")).toBe(false);
		// A leading dot would collide with the dot-directories the agents scan.
		expect(safeSegment(".hidden")).toBe(false);
	});
});
