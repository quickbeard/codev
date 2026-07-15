import { homedir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as install from "@/lib/skill-install.js";
import * as skillhub from "@/lib/skillhub.js";
import { SkillPullApp } from "@/SkillPullApp.js";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const stripAnsi = (s: string) =>
	s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

// A UUID target — the interesting case: the prompt/folder should show the
// resolved name "pg-tuner", never this id.
const ID = "3f9a0000-0000-4000-8000-000000000000";
const META: skillhub.SkillMeta = { id: ID, name: "pg-tuner", version: "1.2.0" };

type Frame = () => string | undefined;
type Stdin = { write: (s: string) => void };

async function waitFor(predicate: () => boolean, tries = 150): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("waitFor: condition not met within timeout");
}

const frameText = (lastFrame: Frame) => stripAnsi(lastFrame() ?? "");
const inSelect = (lastFrame: Frame) => frameText(lastFrame).includes("❯ ");

// Keystrokes written before Ink attaches its input listener are silently
// dropped, so both helpers RETRY until the UI reflects the action. They only act
// while the select prompt is up, so they can't over-shoot or double-fire once
// we've left it.
async function moveToGlobal(stdin: Stdin, lastFrame: Frame): Promise<void> {
	await waitFor(() => {
		if (frameText(lastFrame).includes("❯ Global")) return true;
		if (inSelect(lastFrame)) stdin.write(DOWN);
		return false;
	});
}
async function confirm(
	stdin: Stdin,
	lastFrame: Frame,
	advanced: () => boolean,
): Promise<void> {
	await waitFor(() => {
		if (advanced()) return true;
		if (inSelect(lastFrame)) stdin.write("\r");
		return false;
	});
}

function okResult(dir: string): install.InstallResult {
	return {
		name: "pg-tuner",
		version: "1.2.0",
		id: ID,
		dir: join(dir, "pg-tuner"),
		strippedRoot: "pg-tuner",
	};
}

function mockResolve(meta: skillhub.SkillMeta = META) {
	return vi.spyOn(skillhub, "getSkillMeta").mockResolvedValue(meta);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SkillPullApp", () => {
	test("resolves the name and shows it in the prompt (not the raw id)", async () => {
		mockResolve();
		vi.spyOn(install, "installResolvedSkill").mockResolvedValue(
			okResult(join(process.cwd(), ".claude", "skills")),
		);

		const { lastFrame } = render(
			<SkillPullApp target={ID} force={false} json={false} />,
		);

		await waitFor(() => frameText(lastFrame).includes("pg-tuner"));
		const frame = frameText(lastFrame);
		expect(frame).toContain("Current directory");
		expect(frame).not.toContain(ID);
	});

	test("Enter installs to the current directory with the resolved meta", async () => {
		mockResolve();
		const currentRoot = join(process.cwd(), ".claude", "skills");
		const spy = vi
			.spyOn(install, "installResolvedSkill")
			.mockResolvedValue(okResult(currentRoot));

		const { stdin, lastFrame } = render(
			<SkillPullApp target={ID} force={false} json={false} />,
		);

		await confirm(stdin, lastFrame, () => spy.mock.calls.length > 0);
		expect(spy).toHaveBeenCalledWith(META, {
			rootDir: currentRoot,
			force: false,
		});
		await waitFor(() =>
			frameText(lastFrame).includes("Installed pg-tuner@1.2.0"),
		);
	});

	test("selecting Global installs to the home skills dir", async () => {
		mockResolve();
		const globalRoot = join(homedir(), ".claude", "skills");
		const spy = vi
			.spyOn(install, "installResolvedSkill")
			.mockResolvedValue(okResult(globalRoot));

		const { stdin, lastFrame } = render(
			<SkillPullApp target={ID} force={false} json={false} />,
		);

		await moveToGlobal(stdin, lastFrame);
		await confirm(stdin, lastFrame, () => spy.mock.calls.length > 0);
		expect(spy).toHaveBeenCalledWith(META, {
			rootDir: globalRoot,
			force: false,
		});
	});

	test("passes --force through to the install", async () => {
		mockResolve();
		const spy = vi
			.spyOn(install, "installResolvedSkill")
			.mockResolvedValue(okResult(join(process.cwd(), ".claude", "skills")));

		const { stdin, lastFrame } = render(
			<SkillPullApp target={ID} force={true} json={false} />,
		);
		await confirm(stdin, lastFrame, () => spy.mock.calls.length > 0);
		expect(spy.mock.calls[0]?.[1]).toMatchObject({ force: true });
	});

	test("shows an error when the skill can't be resolved", async () => {
		vi.spyOn(skillhub, "getSkillMeta").mockRejectedValue(
			new Error('Skill "bad-id" not found or not public.'),
		);
		const onDone = vi.fn();

		const { lastFrame } = render(
			<SkillPullApp
				target="bad-id"
				force={false}
				json={false}
				onDone={onDone}
			/>,
		);

		await waitFor(() =>
			frameText(lastFrame).includes("not found or not public"),
		);
		expect(onDone).toHaveBeenCalledWith(false);
	});

	test("shows an error when the install itself fails", async () => {
		mockResolve();
		vi.spyOn(install, "installResolvedSkill").mockRejectedValue(
			new Error("Already installed at X. Pass --force to overwrite."),
		);
		const onDone = vi.fn();

		const { stdin, lastFrame } = render(
			<SkillPullApp target={ID} force={false} json={false} onDone={onDone} />,
		);
		await confirm(stdin, lastFrame, () =>
			frameText(lastFrame).includes("Already installed"),
		);
		await waitFor(() => frameText(lastFrame).includes("Already installed"));
		expect(onDone).toHaveBeenCalledWith(false);
	});
});
