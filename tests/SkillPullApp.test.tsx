import { homedir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SkillAgent } from "@/lib/skill-dirs.js";
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
	const path = join(dir, "pg-tuner");
	return {
		name: "pg-tuner",
		version: "1.2.0",
		id: ID,
		dir: path,
		strippedRoot: "pg-tuner",
		placements: [{ path, mode: "store", agents: ["codev"] }],
	};
}

// Most tests here are about the location step, so they pass `agents` explicitly:
// that skips the agent picker AND keeps them off detectCodevTools(), which reads
// the real machine. The picker has its own tests below.
const CODEV_ONLY: SkillAgent[] = ["codev"];

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
			<SkillPullApp
				target={ID}
				force={false}
				json={false}
				agents={CODEV_ONLY}
			/>,
		);

		await confirm(stdin, lastFrame, () => spy.mock.calls.length > 0);
		expect(spy).toHaveBeenCalledWith(META, {
			target: { kind: "agents", agents: CODEV_ONLY, scope: "current" },
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
			<SkillPullApp
				target={ID}
				force={false}
				json={false}
				agents={CODEV_ONLY}
			/>,
		);

		await moveToGlobal(stdin, lastFrame);
		await confirm(stdin, lastFrame, () => spy.mock.calls.length > 0);
		expect(spy).toHaveBeenCalledWith(META, {
			target: { kind: "agents", agents: CODEV_ONLY, scope: "global" },
			force: false,
		});
	});

	test("passes --force through to the install", async () => {
		mockResolve();
		const spy = vi
			.spyOn(install, "installResolvedSkill")
			.mockResolvedValue(okResult(join(process.cwd(), ".claude", "skills")));

		const { stdin, lastFrame } = render(
			<SkillPullApp
				target={ID}
				force={true}
				json={false}
				agents={CODEV_ONLY}
			/>,
		);
		await confirm(stdin, lastFrame, () => spy.mock.calls.length > 0);
		expect(spy.mock.calls[0]?.[1]).toMatchObject({ force: true });
	});

	// The agent picker. `agents` is left off so the second prompt appears;
	// detectCodevTools is stubbed so the pre-check doesn't depend on the machine.
	describe("agent picker", () => {
		function renderPicker(detected: SkillAgent[] = []) {
			vi.spyOn(install, "defaultAgents").mockReturnValue([
				...detected,
				"codev",
			]);
			return render(<SkillPullApp target={ID} force={false} json={false} />);
		}

		test("appears after the location choice, pre-checked with detected agents", async () => {
			mockResolve();
			vi.spyOn(install, "installResolvedSkill").mockResolvedValue(
				okResult(join(process.cwd(), ".claude", "skills")),
			);
			const { stdin, lastFrame } = renderPicker(["claude"]);

			await waitFor(() => {
				if (frameText(lastFrame).includes("For which agents?")) return true;
				if (inSelect(lastFrame)) stdin.write("\r");
				return false;
			});

			const frame = frameText(lastFrame);
			expect(frame).toContain("[x] Claude Code");
			expect(frame).toContain("[x] CoDev Code");
			// Not configured on this machine, so not pre-checked.
			expect(frame).toContain("[ ] Codex");
			expect(frame).toContain("[ ] OpenCode");
		});

		test("space toggles an agent, and enter installs the checked set", async () => {
			mockResolve();
			const spy = vi
				.spyOn(install, "installResolvedSkill")
				.mockResolvedValue(okResult(join(process.cwd(), ".agents", "skills")));
			const { stdin, lastFrame } = renderPicker();

			await waitFor(() => {
				if (frameText(lastFrame).includes("For which agents?")) return true;
				if (inSelect(lastFrame)) stdin.write("\r");
				return false;
			});
			// Cursor starts on Claude Code; move to Codex and check it.
			await waitFor(() => {
				if (frameText(lastFrame).includes("[x] Codex")) return true;
				if (frameText(lastFrame).includes("❯ [ ] Codex")) stdin.write(" ");
				else stdin.write(DOWN);
				return false;
			});
			await waitFor(() => {
				if (spy.mock.calls.length > 0) return true;
				stdin.write("\r");
				return false;
			});

			expect(spy.mock.calls[0]?.[1]).toMatchObject({
				target: { kind: "agents", agents: ["codex", "codev"] },
			});
		});

		// CoDev Code is the flagship: the picker must not let it be turned off.
		test("CoDev Code cannot be unchecked", async () => {
			mockResolve();
			const spy = vi
				.spyOn(install, "installResolvedSkill")
				.mockResolvedValue(okResult(join(process.cwd(), ".claude", "skills")));
			const { stdin, lastFrame } = renderPicker();

			await waitFor(() => {
				if (frameText(lastFrame).includes("For which agents?")) return true;
				if (inSelect(lastFrame)) stdin.write("\r");
				return false;
			});
			// Walk to CoDev Code and press space repeatedly — it stays checked.
			await waitFor(() => {
				if (frameText(lastFrame).includes("❯ [x] CoDev Code")) return true;
				stdin.write(DOWN);
				return false;
			});
			stdin.write(" ");
			stdin.write(" ");
			expect(frameText(lastFrame)).toContain("[x] CoDev Code");

			await waitFor(() => {
				if (spy.mock.calls.length > 0) return true;
				stdin.write("\r");
				return false;
			});
			expect(spy.mock.calls[0]?.[1]).toMatchObject({
				target: { agents: ["codev"] },
			});
		});
	});

	// A terminal with no raw mode (Git Bash on Windows — see lib/tty.ts). The
	// dispatcher normally routes those to the plain runner, so this covers the
	// case where Ink's stdin isn't the process's own. Unlike an ungated useInput
	// (which throws), an unanswerable picker would just hang forever.
	// ink-testing-library's stdin reports isTTY true and takes no options, so the
	// flag is flipped and the tree re-rendered — Ink recomputes
	// `isRawModeSupported` every render.
	test("without raw mode: explains the missing keyboard instead of prompting", async () => {
		mockResolve();
		const spy = vi.spyOn(install, "installResolvedSkill");
		const onDone = vi.fn();
		const node = (
			<SkillPullApp target={ID} force={false} json={false} onDone={onDone} />
		);

		const instance = render(node);
		instance.stdin.isTTY = false;
		instance.rerender(node);

		await waitFor(() =>
			frameText(instance.lastFrame).includes("cannot supply keystrokes"),
		);
		const frame = frameText(instance.lastFrame);
		expect(frame).toContain("--here, --global, or --dir");
		// Never falls back to a location the user didn't choose.
		expect(frame).not.toContain("❯ ");
		expect(spy).not.toHaveBeenCalled();
		await waitFor(() => onDone.mock.calls.length > 0);
		expect(onDone).toHaveBeenCalledWith(false);
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
