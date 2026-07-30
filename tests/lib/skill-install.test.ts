import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as npm from "@/lib/npm.js";
import { parsePullArgs, runSkillInstall } from "@/lib/skill-install.js";
import * as skillhub from "@/lib/skillhub.js";

let tempDir: string;

const META: skillhub.SkillMeta = {
	id: "3f9a0000-0000-4000-8000-000000000000",
	name: "pg-tuner",
	version: "1.2.0",
};

// A ZIP wrapped in a `pg-tuner/` root folder, like the server publishes.
function skillZip(root = "pg-tuner"): Buffer {
	const zip = new AdmZip();
	zip.addFile(`${root}/SKILL.md`, Buffer.from("# pg-tuner"));
	zip.addFile(`${root}/scripts/run.sh`, Buffer.from("echo hi"));
	return zip.toBuffer();
}

function mockMeta(meta: skillhub.SkillMeta = META) {
	return vi.spyOn(skillhub, "getSkillMeta").mockResolvedValue(meta);
}
function mockDownload(buf: Buffer = skillZip()) {
	return vi.spyOn(skillhub, "downloadSkill").mockResolvedValue(buf);
}

function captureLog() {
	const out: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
		out.push(String(m));
	});
	return out;
}
function captureErr() {
	const out: string[] = [];
	vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
		out.push(String(m));
	});
	return out;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-skill-install-"));
	// The Claude link's mechanism depends on `claude --version`. Pin it above the
	// symlink floor so these tests don't spawn a real process and don't change
	// behavior on a machine where Claude Code is absent or old.
	vi.spyOn(npm, "execAsync").mockResolvedValue({
		error: null,
		stdout: "2.1.220 (Claude Code)",
		stderr: "",
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runSkillInstall", () => {
	test("installs by name: resolves meta, downloads, strips root, extracts", async () => {
		mockMeta();
		const dl = mockDownload();
		const out = captureLog();

		const code = await runSkillInstall(["pg-tuner", "--dir", tempDir]);

		expect(code).toBe(0);
		expect(dl).toHaveBeenCalledWith(META.id);
		const skillDir = join(tempDir, "pg-tuner");
		expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(
			"# pg-tuner",
		);
		expect(existsSync(join(skillDir, "scripts", "run.sh"))).toBe(true);
		expect(out.join("\n")).toContain("Installed pg-tuner@1.2.0 ->");
	});

	test("installs by UUID: names the folder from the resolved name, not the id", async () => {
		const getMeta = mockMeta();
		mockDownload();
		const out = captureLog();

		const code = await runSkillInstall([META.id, "--dir", tempDir]);

		expect(code).toBe(0);
		expect(getMeta).toHaveBeenCalledWith(META.id);
		// Folder is the human name, not the UUID — and the version is shown too.
		expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(true);
		expect(existsSync(join(tempDir, META.id))).toBe(false);
		expect(out.join("\n")).toContain("Installed pg-tuner@1.2.0 ->");
	});

	test("errors when the skill is not found", async () => {
		vi.spyOn(skillhub, "getSkillMeta").mockRejectedValue(
			new Error('Skill "nope" not found or not public.'),
		);
		const dl = vi.spyOn(skillhub, "downloadSkill");
		const errs = captureErr();

		const code = await runSkillInstall(["nope", "--dir", tempDir]);

		expect(code).toBe(1);
		expect(dl).not.toHaveBeenCalled();
		expect(errs.join("\n")).toMatch(/not found or not public/i);
	});

	test("refuses to overwrite an existing install without --force", async () => {
		mockMeta();
		mockDownload();
		mkdirSync(join(tempDir, "pg-tuner"), { recursive: true });
		const errs = captureErr();

		const code = await runSkillInstall(["pg-tuner", "--dir", tempDir]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/Already installed/);
	});

	test("--force overwrites an existing install", async () => {
		mockMeta();
		mockDownload();
		const skillDir = join(tempDir, "pg-tuner");
		mkdirSync(skillDir, { recursive: true });
		captureLog();

		const code = await runSkillInstall([
			"pg-tuner",
			"--dir",
			tempDir,
			"--force",
		]);

		expect(code).toBe(0);
		expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
	});

	test("--json emits a machine-readable summary", async () => {
		mockMeta();
		mockDownload();
		const out = captureLog();

		const code = await runSkillInstall([
			"pg-tuner",
			"--dir",
			tempDir,
			"--json",
		]);

		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		const parsed = JSON.parse(out[0] as string);
		expect(parsed).toMatchObject({
			ok: true,
			name: "pg-tuner",
			version: "1.2.0",
			id: META.id,
			strippedRoot: "pg-tuner",
		});
		expect(parsed.dir).toContain(join("pg-tuner"));
	});

	test("errors when no target is given", async () => {
		const errs = captureErr();
		const code = await runSkillInstall(["--dir", tempDir]);
		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/Usage: codevhub skill pull/);
	});

	test("requires a location flag on the non-interactive path (no prompt available)", async () => {
		const getMeta = vi.spyOn(skillhub, "getSkillMeta");
		const errs = captureErr();

		const code = await runSkillInstall(["pg-tuner"]); // no location flag

		expect(code).toBe(1);
		expect(getMeta).not.toHaveBeenCalled();
		expect(errs.join("\n")).toMatch(/--here, --global, or --dir/i);
	});

	// --dir is an exact path (`<dir>/<name>`), while --here resolves the selected
	// agents' directories under the cwd — the layout the agents actually read.
	test("--dir installs verbatim; --here resolves agent directories", async () => {
		mockMeta();
		mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		expect(await runSkillInstall(["pg-tuner", "--dir", tempDir])).toBe(0);
		expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(true);

		// CoDev Code alone reads .claude/skills, so that is the whole install.
		expect(
			await runSkillInstall(["pg-tuner", "--here", "--agent", "codev"]),
		).toBe(0);
		expect(
			existsSync(join(tempDir, ".claude", "skills", "pg-tuner", "SKILL.md")),
		).toBe(true);
	});

	// The one arrangement that needs two directories: Codex reads only
	// .agents/skills, Claude Code only .claude/skills.
	test("--agent claude,codex extracts once and links the second directory", async () => {
		mockMeta();
		const dl = mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		expect(
			await runSkillInstall(["pg-tuner", "--here", "--agent", "claude,codex"]),
		).toBe(0);

		const store = join(tempDir, ".agents", "skills", "pg-tuner");
		const link = join(tempDir, ".claude", "skills", "pg-tuner");
		expect(readFileSync(join(store, "SKILL.md"), "utf-8")).toBe("# pg-tuner");
		// Downloaded once, extracted once — the second path is a link to the first.
		expect(dl).toHaveBeenCalledTimes(1);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner");
	});

	// Claude Code only follows a symlinked skill dir from v2.1.203; below that the
	// link has to be a real copy or the skill is simply invisible to it.
	test("an older Claude Code gets a copy instead of a link", async () => {
		mockMeta();
		mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		vi.spyOn(npm, "execAsync").mockResolvedValue({
			error: null,
			stdout: "2.1.202 (Claude Code)",
			stderr: "",
		});
		const out = captureLog();

		expect(
			await runSkillInstall(["pg-tuner", "--here", "--agent", "claude,codex"]),
		).toBe(0);

		const link = join(tempDir, ".claude", "skills", "pg-tuner");
		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toBe("# pg-tuner");
		// And it says so rather than claiming a link.
		expect(out.join("\n")).toContain("(copy)");
	});

	test("--all-agents installs for every agent", async () => {
		mockMeta();
		mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		const out = captureLog();

		expect(await runSkillInstall(["pg-tuner", "--here", "--all-agents"])).toBe(
			0,
		);

		const text = out.join("\n");
		for (const label of ["Claude Code", "Codex", "OpenCode", "CoDev Code"]) {
			expect(text).toContain(label);
		}
	});

	// The upgrade path: a skill installed before agent support is a real directory
	// in .claude/skills. Re-pulling with Codex selected has to convert it to a
	// link rather than leave a stale second copy behind.
	test("--force converts a pre-existing real directory into a link", async () => {
		mockMeta();
		mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		const stale = join(tempDir, ".claude", "skills", "pg-tuner");
		mkdirSync(stale, { recursive: true });
		captureLog();

		expect(
			await runSkillInstall([
				"pg-tuner",
				"--here",
				"--agent",
				"claude,codex",
				"--force",
			]),
		).toBe(0);

		expect(lstatSync(stale).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(stale, "SKILL.md"), "utf-8")).toBe("# pg-tuner");
	});

	test("without --force an existing agent directory stops the install", async () => {
		mockMeta();
		mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);
		mkdirSync(join(tempDir, ".claude", "skills", "pg-tuner"), {
			recursive: true,
		});
		const errs = captureErr();

		const code = await runSkillInstall([
			"pg-tuner",
			"--here",
			"--agent",
			"claude,codex",
		]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/Already installed/);
		// Refused before anything was removed — the store was never created.
		expect(existsSync(join(tempDir, ".agents", "skills", "pg-tuner"))).toBe(
			false,
		);
	});

	test("rejects an unknown agent name", async () => {
		const getMeta = vi.spyOn(skillhub, "getSkillMeta");
		const errs = captureErr();

		const code = await runSkillInstall([
			"pg-tuner",
			"--here",
			"--agent",
			"cursor",
		]);

		expect(code).toBe(1);
		expect(getMeta).not.toHaveBeenCalled();
		expect(errs.join("\n")).toContain("Unknown agent: cursor");
	});

	// CoDev Code is the flagship: naming other agents never drops it.
	test("CoDev Code is always in the agent set", () => {
		expect(parsePullArgs(["x", "--agent", "claude"]).agents).toEqual([
			"claude",
			"codev",
		]);
		expect(parsePullArgs(["x", "--agent", "codex"]).agents).toEqual([
			"codex",
			"codev",
		]);
	});

	test("--dir cannot be combined with --agent", async () => {
		const errs = captureErr();
		const code = await runSkillInstall([
			"pg-tuner",
			"--dir",
			tempDir,
			"--agent",
			"claude",
		]);
		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/exact path/i);
	});

	// A mistyped flag must fail loudly. Silently ignoring `--forse` would look
	// like a successful run that quietly refused to overwrite.
	test("rejects an unknown flag instead of ignoring it", async () => {
		const getMeta = vi.spyOn(skillhub, "getSkillMeta");
		const errs = captureErr();

		const code = await runSkillInstall([
			"pg-tuner",
			"--dir",
			tempDir,
			"--forse",
		]);

		expect(code).toBe(1);
		expect(getMeta).not.toHaveBeenCalled();
		expect(errs.join("\n")).toContain("Unknown flag: --forse");
	});

	// No `-f` alias: elsewhere in this CLI `-f` forces a fresh login, which costs
	// nothing, while here it would rm -rf a skill directory. The reflex must miss.
	test("does not accept -f as a --force alias", async () => {
		mockMeta();
		mockDownload();
		mkdirSync(join(tempDir, "pg-tuner"), { recursive: true });
		const errs = captureErr();

		const code = await runSkillInstall(["pg-tuner", "--dir", tempDir, "-f"]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("Unknown flag: -f");
		// The pre-existing directory is still there — nothing was overwritten.
		expect(existsSync(join(tempDir, "pg-tuner"))).toBe(true);
		expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(false);
	});

	test("rejects conflicting location flags", async () => {
		const errs = captureErr();

		expect(await runSkillInstall(["pg-tuner", "--here", "--global"])).toBe(1);
		expect(
			await runSkillInstall(["pg-tuner", "--here", "--dir", tempDir]),
		).toBe(1);
		expect(errs.join("\n")).toMatch(/not both/i);
	});

	test("a --dir value is never read as a flag or a target", () => {
		// The value is consumed positionally, so even a flag-shaped-looking name
		// stays the directory, and the target is still the first real positional.
		const parsed = parsePullArgs(["--dir", "--here", "pg-tuner"]);
		expect(parsed.error).toBe("Missing value for --dir.");

		const ok = parsePullArgs(["--dir", "build/skills", "pg-tuner", "--force"]);
		expect(ok).toMatchObject({
			target: "pg-tuner",
			dir: "build/skills",
			force: true,
		});
		expect(ok.location).toBeUndefined();
	});

	test("rejects a server name that escapes the target dir (no download, no write)", async () => {
		vi.spyOn(skillhub, "getSkillMeta").mockResolvedValue({
			id: META.id,
			name: "../../evil",
			version: "1.0.0",
		});
		const dl = mockDownload();
		const errs = captureErr();

		const code = await runSkillInstall(["whatever", "--dir", tempDir]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/unsafe name/i);
		// The path is validated before any network or filesystem work.
		expect(dl).not.toHaveBeenCalled();
		expect(existsSync(join(tempDir, "..", "evil"))).toBe(false);
	});

	test("rejects a server name containing a path separator", async () => {
		vi.spyOn(skillhub, "getSkillMeta").mockResolvedValue({
			id: META.id,
			name: "nested/name",
			version: "1.0.0",
		});
		const dl = mockDownload();
		const errs = captureErr();

		const code = await runSkillInstall(["whatever", "--dir", tempDir]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/unsafe name/i);
		expect(dl).not.toHaveBeenCalled();
	});
});
