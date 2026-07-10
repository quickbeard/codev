import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectZip, pathExists, zipDirectory } from "@/lib/archive.js";
import {
	adminReviewSkill,
	saveSkillMetadata,
	submitSkill,
	uploadSkill,
} from "@/lib/skillhub.js";

export interface ParsedPublish {
	path?: string;
	json: boolean;
	draftOnly: boolean;
	autoApprove: boolean;
	error?: string;
}

// Parse `push` args: first non-flag token is the skill path; flags are
// --draft-only, --auto-approve, --json. Shared by the interactive (index → app)
// and non-interactive (runSkillPublish) paths so parsing lives in one place.
export function parsePublishArgs(args: string[]): ParsedPublish {
	const json = args.includes("--json");
	const draftOnly = args.includes("--draft-only");
	const autoApprove = args.includes("--auto-approve");
	const positionals = args.filter((a) => !a.startsWith("-"));
	return { path: positionals[0], json, draftOnly, autoApprove };
}

export interface PublishArchive {
	zipBuffer: Buffer;
	fileName: string;
	// Files included in the archive (relative to the skill root), for preview.
	files: string[];
	// Uncompressed total of the included files.
	totalBytes: number;
	// Names excluded by the ignore list (secrets/junk/VCS), for transparency.
	skipped: string[];
	// "dir" (a folder we zipped) or "zip" (a pre-built archive read as-is).
	source: "dir" | "zip";
}

// Turn a user-supplied path into an uploadable archive. A directory must have a
// SKILL.md at its root and is zipped (junk/secrets dropped, caps enforced); a
// file must be a `.zip`, which is read as-is but still inspected for the preview
// and size cap. Throws with a plain message on any validation failure.
export async function preparePublishArchive(
	inputPath: string,
): Promise<PublishArchive> {
	const absPath = resolve(inputPath);
	if (!(await pathExists(absPath))) {
		throw new Error(`Path not found: ${absPath}`);
	}
	const s = await stat(absPath);

	if (s.isDirectory()) {
		if (!(await pathExists(join(absPath, "SKILL.md")))) {
			throw new Error("Directory must contain a SKILL.md at its root.");
		}
		const rootName = basename(absPath);
		const { buffer, files, totalBytes, skipped } = await zipDirectory(
			absPath,
			rootName,
		);
		return {
			zipBuffer: buffer,
			fileName: `${rootName}.zip`,
			files,
			totalBytes,
			skipped,
			source: "dir",
		};
	}

	if (s.isFile()) {
		if (!absPath.endsWith(".zip")) {
			throw new Error("File must be a .zip archive.");
		}
		const buffer = await readFile(absPath);
		const { files, totalBytes } = inspectZip(buffer);
		return {
			zipBuffer: buffer,
			fileName: basename(absPath),
			files,
			totalBytes,
			skipped: [],
			source: "zip",
		};
	}

	throw new Error("Path must be a directory or a .zip file.");
}

export type PublishStep = "upload" | "metadata" | "submit" | "approve";
export type StepStatus = "start" | "done";

export interface PublishOpts {
	draftOnly: boolean;
	autoApprove: boolean;
}

export interface PublishResult {
	skillId: string;
	status: "DRAFT" | "SUBMITTED" | "PUBLIC";
	steps: string[];
}

// Which steps a given set of options will run, in order. Drives the interactive
// progress display so it can render the rows before they start.
export function plannedSteps(opts: PublishOpts): PublishStep[] {
	const steps: PublishStep[] = ["upload", "metadata"];
	if (!opts.draftOnly) {
		steps.push("submit");
		if (opts.autoApprove) steps.push("approve");
	}
	return steps;
}

// Run the publish pipeline: upload -> save metadata (DRAFT) -> submit (unless
// --draft-only) -> admin approve (only with --auto-approve, admin-only). No
// console I/O — `onStep` lets the Ink UI animate each stage; the non-interactive
// runner passes nothing.
export async function publishSkill(
	archive: { zipBuffer: Buffer; fileName: string },
	opts: PublishOpts,
	onStep?: (step: PublishStep, status: StepStatus) => void,
): Promise<PublishResult> {
	onStep?.("upload", "start");
	const uploaded = await uploadSkill(archive.zipBuffer, archive.fileName);
	if (!uploaded.skill_id) {
		throw new Error("Upload succeeded but no skill_id was returned.");
	}
	const skillId = uploaded.skill_id;
	onStep?.("upload", "done");

	onStep?.("metadata", "start");
	await saveSkillMetadata(skillId, {});
	onStep?.("metadata", "done");

	const steps = ["uploaded", "metadata saved (DRAFT)"];
	let status: PublishResult["status"] = opts.draftOnly ? "DRAFT" : "SUBMITTED";

	if (!opts.draftOnly) {
		onStep?.("submit", "start");
		await submitSkill(skillId);
		onStep?.("submit", "done");
		steps.push("submitted for review (SUBMITTED)");

		if (opts.autoApprove) {
			onStep?.("approve", "start");
			await adminReviewSkill(skillId, "APPROVE", "Auto-approved via CLI");
			onStep?.("approve", "done");
			steps.push("approved (PUBLIC)");
			status = "PUBLIC";
		}
	}

	return { skillId, status, steps };
}

export function formatPublishResult(r: PublishResult, json: boolean): string {
	if (json) {
		return JSON.stringify({
			ok: true,
			skillId: r.skillId,
			status: r.status,
			steps: r.steps,
		});
	}
	const lines = [
		`Published skill ${r.skillId}`,
		...r.steps.map((s) => `  ${s}`),
	];
	if (r.status === "SUBMITTED") {
		lines.push(
			"",
			"Status: SUBMITTED — an admin must approve it before it appears on the public hub.",
		);
	} else if (r.status === "DRAFT") {
		lines.push(
			"",
			"Status: DRAFT — run `codevhub skill push` again (without --draft-only) to submit.",
		);
	} else if (r.status === "PUBLIC") {
		lines.push("", "Status: PUBLIC — the skill is live on the hub.");
	}
	return lines.join("\n");
}

// Non-interactive path (piped/CI, or --json). No confirmation prompt — the
// interactive preview/confirm lives in SkillPushApp. Excluded files are noted on
// stderr (never stdout, so --json stays clean). Returns the exit code.
export async function runSkillPublish(args: string[]): Promise<number> {
	const parsed = parsePublishArgs(args);
	if (parsed.error) {
		console.error(parsed.error);
		return 1;
	}
	if (!parsed.path) {
		console.error(
			"Usage: codevhub skill push <path> [--draft-only] [--auto-approve] [--json]",
		);
		return 1;
	}

	try {
		const archive = await preparePublishArchive(parsed.path);
		if (!parsed.json && archive.skipped.length > 0) {
			console.error(`Excluded from upload: ${archive.skipped.join(", ")}`);
		}
		const result = await publishSkill(archive, {
			draftOnly: parsed.draftOnly,
			autoApprove: parsed.autoApprove,
		});
		console.log(formatPublishResult(result, parsed.json));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
