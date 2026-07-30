import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	parsePullArgs,
	runSkillInstall,
	skillsDirFor,
} from "@/lib/skill-install.js";
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

	// --dir is an exact path (`<dir>/<name>`), while --here reproduces the
	// picker's "Current directory" choice — which is the layout agents read.
	test("--dir installs verbatim; --here adds the .claude/skills segment", async () => {
		mockMeta();
		mockDownload();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		expect(await runSkillInstall(["pg-tuner", "--dir", tempDir])).toBe(0);
		expect(existsSync(join(tempDir, "pg-tuner", "SKILL.md"))).toBe(true);

		expect(await runSkillInstall(["pg-tuner", "--here"])).toBe(0);
		expect(
			existsSync(join(tempDir, ".claude", "skills", "pg-tuner", "SKILL.md")),
		).toBe(true);
	});

	test("--global resolves to the home skills dir", () => {
		// Asserted through the pure helpers so the test never writes to a real home.
		expect(parsePullArgs(["pg-tuner", "--global"]).location).toBe("global");
		expect(skillsDirFor("global")).toBe(join(homedir(), ".claude", "skills"));
		expect(skillsDirFor("current")).toBe(
			join(process.cwd(), ".claude", "skills"),
		);
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
