import { homedir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as install from "@/lib/skill-install.js";
import { SkillPullApp } from "@/SkillPullApp.js";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const stripAnsi = (s: string) =>
	s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

async function waitFor(predicate: () => boolean, tries = 100): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("waitFor: condition not met within timeout");
}

function okResult(dir: string): install.InstallResult {
	return {
		name: "pg-tuner",
		version: "1.2.0",
		id: "id-1",
		dir: join(dir, "pg-tuner"),
		strippedRoot: "pg-tuner",
	};
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SkillPullApp", () => {
	test("Enter on the default option installs to the current directory", async () => {
		const currentRoot = join(process.cwd(), ".claude", "skills");
		const spy = vi
			.spyOn(install, "installSkill")
			.mockResolvedValue(okResult(currentRoot));

		const { stdin, lastFrame } = render(
			<SkillPullApp target="pg-tuner" force={false} json={false} />,
		);

		await waitFor(() =>
			stripAnsi(lastFrame() ?? "").includes("Current directory"),
		);
		stdin.write("\r"); // accept default (index 0 = Current directory)

		await waitFor(() => spy.mock.calls.length > 0);
		expect(spy).toHaveBeenCalledWith("pg-tuner", {
			rootDir: currentRoot,
			force: false,
		});
		await waitFor(() =>
			stripAnsi(lastFrame() ?? "").includes("Installed pg-tuner@1.2.0"),
		);
	});

	test("selecting Global installs to the home skills dir", async () => {
		const globalRoot = join(homedir(), ".claude", "skills");
		const spy = vi
			.spyOn(install, "installSkill")
			.mockResolvedValue(okResult(globalRoot));

		const { stdin, lastFrame } = render(
			<SkillPullApp target="pg-tuner" force={false} json={false} />,
		);

		await waitFor(() => stripAnsi(lastFrame() ?? "").includes("Global"));
		stdin.write(DOWN); // move to "Global"
		await waitFor(() => {
			const frame = stripAnsi(lastFrame() ?? "");
			return frame.includes("❯ Global");
		});
		stdin.write("\r");

		await waitFor(() => spy.mock.calls.length > 0);
		expect(spy).toHaveBeenCalledWith("pg-tuner", {
			rootDir: globalRoot,
			force: false,
		});
	});

	test("passes --force through to installSkill", async () => {
		const spy = vi
			.spyOn(install, "installSkill")
			.mockResolvedValue(okResult(join(process.cwd(), ".claude", "skills")));

		const { stdin, lastFrame } = render(
			<SkillPullApp target="pg-tuner" force={true} json={false} />,
		);
		await waitFor(() =>
			stripAnsi(lastFrame() ?? "").includes("Current directory"),
		);
		stdin.write("\r");

		await waitFor(() => spy.mock.calls.length > 0);
		expect(spy.mock.calls[0]?.[1]).toMatchObject({ force: true });
	});

	test("renders the error and does not crash when install fails", async () => {
		vi.spyOn(install, "installSkill").mockRejectedValue(
			new Error("Already installed at X. Pass --force to overwrite."),
		);
		const onDone = vi.fn();

		const { stdin, lastFrame } = render(
			<SkillPullApp
				target="pg-tuner"
				force={false}
				json={false}
				onDone={onDone}
			/>,
		);
		await waitFor(() =>
			stripAnsi(lastFrame() ?? "").includes("Current directory"),
		);
		stdin.write("\r");

		await waitFor(() =>
			stripAnsi(lastFrame() ?? "").includes("Already installed"),
		);
		expect(onDone).toHaveBeenCalledWith(false);
	});
});
