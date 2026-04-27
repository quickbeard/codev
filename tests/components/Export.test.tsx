import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { Export } from "@/components/Export.js";

let tempHome: string;
let projectCwd: string;
let homedirSpy: ReturnType<typeof spyOn>;
let cwdSpy: ReturnType<typeof spyOn>;

function mungeCwd(cwd: string): string {
	const dashed = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
	return dashed.startsWith("-") ? dashed : `-${dashed}`;
}

function seedClaudeSession(): void {
	const claudeDir = join(
		tempHome,
		".claude",
		"projects",
		mungeCwd(realpathSync(projectCwd)),
	);
	mkdirSync(claudeDir, { recursive: true });
	const lines = [
		JSON.stringify({
			type: "user",
			timestamp: "2026-04-27T18:32:05Z",
			sessionId: "abcdefab-1234-5678-9abc-def012345678",
			message: { role: "user", content: "Refactor auth module" },
		}),
		JSON.stringify({
			type: "assistant",
			timestamp: "2026-04-27T18:32:30Z",
			sessionId: "abcdefab-1234-5678-9abc-def012345678",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Will do." }],
			},
		}),
	];
	writeFileSync(join(claudeDir, "session.jsonl"), lines.join("\n"));
}

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-export-comp-")));
	projectCwd = join(tempHome, "works", "myapp");
	mkdirSync(projectCwd, { recursive: true });
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	cwdSpy = spyOn(process, "cwd").mockReturnValue(projectCwd);
});

afterEach(() => {
	cleanup();
	homedirSpy.mockRestore();
	cwdSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("Export component", () => {
	test("renders the completion summary after work finishes", async () => {
		seedClaudeSession();
		const { frames } = render(<Export />);
		// Allow the runExport promise to settle and the deferred-exit effect
		// to fire after the terminal frame commits.
		await new Promise((r) => setTimeout(r, 250));

		// Strip the terminal-width line wraps that ink-testing-library inserts,
		// so we can match against the full unbroken output dir path.
		const history = allFrames(frames).replace(/\n/g, "");
		expect(history).toContain("Exported");
		expect(history).toContain("Claude Code: 1");
		expect(history).toContain(".codev/logs/works-myapp");
	});

	test("shows skipped agents inline with a 0 count and a hint", async () => {
		seedClaudeSession();
		const { frames } = render(<Export />);
		await new Promise((r) => setTimeout(r, 250));

		// Codex and OpenCode have no activity in this fixture, so they appear
		// as zero-count rows with the "(no activity here)" suffix, sharing the
		// same "- " bullet as the active Claude Code row.
		const history = allFrames(frames);
		expect(history).toContain("- Claude Code: 1");
		expect(history).toContain("- Codex: 0 (no activity here)");
		expect(history).toContain("- OpenCode: 0 (no activity here)");
	});

	test("ends with the Happy coding sign-off", async () => {
		seedClaudeSession();
		const { frames } = render(<Export />);
		await new Promise((r) => setTimeout(r, 250));

		const history = allFrames(frames);
		expect(history).toContain("Happy coding");
	});

	test("emits at least one progress frame before completing", async () => {
		seedClaudeSession();
		const { frames } = render(<Export />);
		await new Promise((r) => setTimeout(r, 250));

		// Find a mid-run frame — one that contains a "Checking" or "Reading"
		// status string but does NOT yet contain the final "Exported" text.
		const interim = frames.find(
			(f) =>
				(f.includes("Checking") || f.includes("Reading")) &&
				!f.includes("Exported"),
		);
		expect(interim).toBeDefined();
	});

	test("renders the completion frame even though exit() is called", async () => {
		// Regression test: an earlier version called exit() inside the work
		// promise, racing React's commit cycle so the final frame never
		// flushed. Asserting that the LAST non-empty frame contains the
		// summary proves the deferred-exit fix is in place. (ink-testing-
		// library appends an empty frame when the component unmounts.)
		seedClaudeSession();
		const { frames } = render(<Export />);
		await new Promise((r) => setTimeout(r, 250));

		const meaningful = frames.filter((f) => f.trim().length > 0);
		const lastFrame = meaningful[meaningful.length - 1] ?? "";
		expect(lastFrame).toContain("Exported");
	});
});
