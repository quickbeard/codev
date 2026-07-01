import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	formatPublishResult,
	type PublishResult,
	type PublishStep,
	parsePublishArgs,
	plannedSteps,
	preparePublishArchive,
	publishSkill,
	runSkillPublish,
	type StepStatus,
} from "@/lib/skill-publish.js";
import * as skillhub from "@/lib/skillhub.js";

let tempDir: string;

// Create a skill directory with a SKILL.md plus the given extra files.
function makeSkillDir(
	name: string,
	extra: Record<string, string> = {},
): string {
	const dir = join(tempDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "# skill");
	for (const [rel, contents] of Object.entries(extra)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, contents);
	}
	return dir;
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

// Stub the four network functions so publishSkill/runSkillPublish never touch
// the wire.
function mockNetwork(skillId = "sk-1") {
	const upload = vi
		.spyOn(skillhub, "uploadSkill")
		.mockResolvedValue({ success: true, skill_id: skillId, status: "PENDING" });
	const meta = vi.spyOn(skillhub, "saveSkillMetadata").mockResolvedValue();
	const submit = vi.spyOn(skillhub, "submitSkill").mockResolvedValue();
	const review = vi.spyOn(skillhub, "adminReviewSkill").mockResolvedValue();
	return { upload, meta, submit, review };
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-skill-publish-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("parsePublishArgs", () => {
	test("first non-flag token is the path; flags are read anywhere", () => {
		expect(parsePublishArgs(["./my-skill"])).toEqual({
			path: "./my-skill",
			json: false,
			draftOnly: false,
			autoApprove: false,
		});
		expect(
			parsePublishArgs(["--draft-only", "./s", "--json", "--auto-approve"]),
		).toEqual({
			path: "./s",
			json: true,
			draftOnly: true,
			autoApprove: true,
		});
	});
});

describe("plannedSteps", () => {
	test("default runs upload, metadata, submit", () => {
		expect(plannedSteps({ draftOnly: false, autoApprove: false })).toEqual([
			"upload",
			"metadata",
			"submit",
		]);
	});
	test("--draft-only stops after metadata", () => {
		expect(plannedSteps({ draftOnly: true, autoApprove: false })).toEqual([
			"upload",
			"metadata",
		]);
	});
	test("--auto-approve appends approve", () => {
		expect(plannedSteps({ draftOnly: false, autoApprove: true })).toEqual([
			"upload",
			"metadata",
			"submit",
			"approve",
		]);
	});
	test("--auto-approve is ignored under --draft-only", () => {
		expect(plannedSteps({ draftOnly: true, autoApprove: true })).toEqual([
			"upload",
			"metadata",
		]);
	});
});

describe("preparePublishArchive", () => {
	test("zips a directory, includes real files, and excludes secrets/junk", async () => {
		const dir = makeSkillDir("pg-tuner", {
			"scripts/run.sh": "echo hi",
			".env": "SECRET=1",
			".DS_Store": "junk",
			"tests/run.test.sh": "echo test",
			"logs/run.log": "log line",
		});
		mkdirSync(join(dir, ".git"), { recursive: true });
		writeFileSync(join(dir, ".git", "config"), "[core]");

		const a = await preparePublishArchive(dir);

		expect(a.source).toBe("dir");
		expect(a.fileName).toBe("pg-tuner.zip");
		expect(a.files.sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
		expect(a.skipped).toContain(".env");
		expect(a.skipped).toContain(".DS_Store");
		expect(a.skipped).toContain(".git/");
		expect(a.skipped).toContain("tests/");
		expect(a.skipped).toContain("logs/");

		// The excluded files really are absent from the produced archive.
		const names = new AdmZip(a.zipBuffer).getEntries().map((e) => e.entryName);
		expect(names).toContain("pg-tuner/SKILL.md");
		expect(names).toContain("pg-tuner/scripts/run.sh");
		expect(names.some((n) => n.includes(".env"))).toBe(false);
		expect(names.some((n) => n.includes(".git"))).toBe(false);
		expect(names.some((n) => n.includes("tests/"))).toBe(false);
		expect(names.some((n) => n.includes("logs/"))).toBe(false);
	});

	test("rejects a directory with no SKILL.md", async () => {
		const dir = join(tempDir, "no-skill");
		mkdirSync(dir, { recursive: true });
		await expect(preparePublishArchive(dir)).rejects.toThrow(/SKILL\.md/);
	});

	test("reads a .zip file as-is and inspects it", async () => {
		const zip = new AdmZip();
		zip.addFile("SKILL.md", Buffer.from("# s"));
		const zipPath = join(tempDir, "bundle.zip");
		writeFileSync(zipPath, zip.toBuffer());

		const a = await preparePublishArchive(zipPath);
		expect(a.source).toBe("zip");
		expect(a.fileName).toBe("bundle.zip");
		expect(a.files).toEqual(["SKILL.md"]);
		expect(a.skipped).toEqual([]);
	});

	test("rejects a non-zip file", async () => {
		const file = join(tempDir, "notes.txt");
		writeFileSync(file, "hi");
		await expect(preparePublishArchive(file)).rejects.toThrow(/\.zip/);
	});

	test("rejects a missing path", async () => {
		await expect(preparePublishArchive(join(tempDir, "nope"))).rejects.toThrow(
			/not found/i,
		);
	});
});

describe("publishSkill", () => {
	const archive = { zipBuffer: Buffer.from("z"), fileName: "s.zip" };

	test("default: upload -> metadata -> submit, status SUBMITTED", async () => {
		const net = mockNetwork();
		const events: [PublishStep, StepStatus][] = [];

		const r = await publishSkill(
			archive,
			{ draftOnly: false, autoApprove: false },
			(step, status) => events.push([step, status]),
		);

		expect(net.upload).toHaveBeenCalledOnce();
		expect(net.meta).toHaveBeenCalledWith("sk-1", {});
		expect(net.submit).toHaveBeenCalledWith("sk-1");
		expect(net.review).not.toHaveBeenCalled();
		expect(r.status).toBe("SUBMITTED");
		expect(r.skillId).toBe("sk-1");
		expect(events).toEqual([
			["upload", "start"],
			["upload", "done"],
			["metadata", "start"],
			["metadata", "done"],
			["submit", "start"],
			["submit", "done"],
		]);
	});

	test("--draft-only stops after metadata, status DRAFT", async () => {
		const net = mockNetwork();
		const r = await publishSkill(archive, {
			draftOnly: true,
			autoApprove: false,
		});
		expect(net.submit).not.toHaveBeenCalled();
		expect(net.review).not.toHaveBeenCalled();
		expect(r.status).toBe("DRAFT");
	});

	test("--auto-approve approves after submit, status PUBLIC", async () => {
		const net = mockNetwork();
		const r = await publishSkill(archive, {
			draftOnly: false,
			autoApprove: true,
		});
		expect(net.submit).toHaveBeenCalledWith("sk-1");
		expect(net.review).toHaveBeenCalledWith(
			"sk-1",
			"APPROVE",
			"Auto-approved via CLI",
		);
		expect(r.status).toBe("PUBLIC");
	});

	test("throws when upload returns no skill_id", async () => {
		vi.spyOn(skillhub, "uploadSkill").mockResolvedValue({ success: true });
		const meta = vi.spyOn(skillhub, "saveSkillMetadata").mockResolvedValue();
		await expect(
			publishSkill(archive, { draftOnly: false, autoApprove: false }),
		).rejects.toThrow(/no skill_id/i);
		expect(meta).not.toHaveBeenCalled();
	});
});

describe("formatPublishResult", () => {
	const base: PublishResult = {
		skillId: "sk-1",
		status: "SUBMITTED",
		steps: [
			"uploaded",
			"metadata saved (DRAFT)",
			"submitted for review (SUBMITTED)",
		],
	};

	test("human output shows the id, steps, and SUBMITTED hint", () => {
		const out = formatPublishResult(base, false);
		expect(out).toContain("Published skill sk-1");
		expect(out).toContain("submitted for review (SUBMITTED)");
		expect(out).toMatch(/Status: SUBMITTED/);
	});

	test("json output is a single machine-readable line", () => {
		expect(JSON.parse(formatPublishResult(base, true))).toEqual({
			ok: true,
			skillId: "sk-1",
			status: "SUBMITTED",
			steps: base.steps,
		});
	});

	test("DRAFT and PUBLIC carry their own hints", () => {
		expect(formatPublishResult({ ...base, status: "DRAFT" }, false)).toMatch(
			/Status: DRAFT/,
		);
		expect(formatPublishResult({ ...base, status: "PUBLIC" }, false)).toMatch(
			/Status: PUBLIC/,
		);
	});
});

describe("runSkillPublish", () => {
	test("errors with usage when no path is given", async () => {
		const errs = captureErr();
		const code = await runSkillPublish(["--json"]);
		expect(code).toBe(1);
		expect(errs.join("\n")).toMatch(/Usage: codev skill push/);
	});

	test("publishes a directory and prints the result (exit 0)", async () => {
		mockNetwork();
		const dir = makeSkillDir("pg-tuner");
		const out = captureLog();

		const code = await runSkillPublish([dir]);

		expect(code).toBe(0);
		expect(out.join("\n")).toContain("Published skill sk-1");
	});

	test("--json emits a machine-readable summary", async () => {
		mockNetwork();
		const dir = makeSkillDir("pg-tuner");
		const out = captureLog();

		const code = await runSkillPublish([dir, "--json"]);

		expect(code).toBe(0);
		expect(JSON.parse(out[0] as string)).toMatchObject({
			ok: true,
			skillId: "sk-1",
			status: "SUBMITTED",
		});
	});

	test("notes excluded files on stderr (not stdout)", async () => {
		mockNetwork();
		const dir = makeSkillDir("pg-tuner", { ".env": "SECRET=1" });
		captureLog();
		const errs = captureErr();

		await runSkillPublish([dir]);

		expect(errs.join("\n")).toMatch(/Excluded from upload:.*\.env/);
	});

	test("returns exit 1 with the message on failure", async () => {
		vi.spyOn(skillhub, "uploadSkill").mockRejectedValue(
			new Error("name already taken"),
		);
		const dir = makeSkillDir("pg-tuner");
		const errs = captureErr();

		const code = await runSkillPublish([dir]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("name already taken");
	});
});
