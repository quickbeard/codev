import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as remove from "@/lib/remove.js";
import { RemoveApp } from "@/RemoveApp.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function waitForFrame(
	frames: string[],
	needle: string,
	maxMs = 3_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (frames.join("\n").includes(needle)) {
			await new Promise((r) => setTimeout(r, 10));
			return;
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

function stubRunRemove(result: remove.RemoveResult) {
	return vi.spyOn(remove, "runRemove").mockResolvedValue(result);
}

function history(frames: string[]): string {
	return frames.join("\n");
}

// Ink wraps long lines at the terminal width, so substrings that fit on one
// logical line can be split across two rendered lines. Normalize whitespace so
// the assertion checks the text regardless of where the wrap landed.
function flat(s: string): string {
	return s.replace(/\s+/g, " ");
}

const SUCCESS_RESULT: remove.RemoveResult = {
	steps: [
		{ label: "SSO", detail: "signed out", status: "ok" },
		{ label: "Shims", detail: "removed 3 shims", status: "ok" },
		{
			label: "Claude Code config",
			detail: "restored from /x/.claude/settings.json.backup",
			status: "ok",
		},
		{ label: "Codex config", detail: "nothing to restore", status: "noop" },
		{
			label: "OpenCode config",
			detail: "nothing to restore",
			status: "noop",
		},
		{ label: "~/.codev-hub", detail: "removed /x/.codev", status: "ok" },
	],
	anyFailed: false,
};

const FAILED_RESULT: remove.RemoveResult = {
	steps: [
		{ label: "SSO", detail: "signed out", status: "ok" },
		{ label: "Shims", detail: "boom", status: "failed" },
		{
			label: "Claude Code config",
			detail: "nothing to restore",
			status: "noop",
		},
		{ label: "Codex config", detail: "nothing to restore", status: "noop" },
		{ label: "OpenCode config", detail: "nothing to restore", status: "noop" },
		{ label: "~/.codev-hub", detail: "permission denied", status: "failed" },
	],
	anyFailed: true,
};

describe("RemoveApp", () => {
	test("shows the warning and prompt by default", () => {
		const spy = stubRunRemove(SUCCESS_RESULT);
		const { lastFrame } = render(<RemoveApp />);
		const out = lastFrame() ?? "";
		expect(out).toContain(
			"Everything will be reverted to the pre-CoDev state. Do you want to proceed?",
		);
		expect(out).toContain("Continue? [y/N]");
		expect(spy).not.toHaveBeenCalled();
	});

	test("'y' + Enter starts the remove flow and shows the success message", async () => {
		stubRunRemove(SUCCESS_RESULT);
		const { stdin, frames } = render(<RemoveApp />);
		stdin.write("y\r");
		await waitForFrame(frames, "Removed successfully.");
		const out = flat(history(frames));
		expect(out).toContain(
			"Removed successfully. You can now run npm uninstall -g codev-ai to remove the CoDev package. Restart your terminal to apply.",
		);
	});

	test("Enter alone at the prompt aborts (default No)", async () => {
		const spy = stubRunRemove(SUCCESS_RESULT);
		const { stdin, frames } = render(<RemoveApp />);
		stdin.write("\r");
		await waitForFrame(frames, "Abort.");
		expect(history(frames)).toContain("Abort.");
		expect(spy).not.toHaveBeenCalled();
	});

	test("'n' + Enter aborts without invoking runRemove", async () => {
		const spy = stubRunRemove(SUCCESS_RESULT);
		const { stdin, frames } = render(<RemoveApp />);
		stdin.write("n\r");
		await waitForFrame(frames, "Abort.");
		expect(history(frames)).toContain("Abort.");
		expect(spy).not.toHaveBeenCalled();
	});

	test("gibberish + Enter aborts (apt-style)", async () => {
		const spy = stubRunRemove(SUCCESS_RESULT);
		const { stdin, frames } = render(<RemoveApp />);
		stdin.write("maybe\r");
		await waitForFrame(frames, "Abort.");
		expect(history(frames)).toContain("Abort.");
		expect(spy).not.toHaveBeenCalled();
	});

	test("skipConfirm bypasses the prompt and runs immediately", async () => {
		const spy = stubRunRemove(SUCCESS_RESULT);
		const { frames } = render(<RemoveApp skipConfirm />);
		await waitForFrame(frames, "Removed successfully.");
		expect(spy).toHaveBeenCalledOnce();
		const out = flat(history(frames));
		expect(out).toContain("Removing CoDev components...");
		expect(out).toContain("Removed successfully.");
	});

	test("surfaces a non-fatal CodeGraph warning above the success message", async () => {
		stubRunRemove({
			steps: [
				...SUCCESS_RESULT.steps,
				{
					label: "CodeGraph",
					detail: "CodeGraph not available — skipped: spawn codegraph ENOENT",
					status: "warning",
				},
			],
			anyFailed: false,
		});
		const { frames } = render(<RemoveApp skipConfirm />);
		await waitForFrame(frames, "Removed successfully.");
		const out = flat(history(frames));
		expect(out).toContain("▲ CodeGraph: CodeGraph not available");
		// A warning does not fail the remove — the success message still shows.
		expect(out).toContain("Removed successfully.");
	});

	test("failure surfaces 'Some steps failed' with the failed step details", async () => {
		stubRunRemove(FAILED_RESULT);
		const { frames } = render(<RemoveApp skipConfirm />);
		await waitForFrame(frames, "Some steps failed:");
		const out = history(frames);
		expect(out).toContain("Some steps failed:");
		expect(out).toContain("Shims: boom");
		expect(out).toContain("~/.codev-hub: permission denied");
		// noop/ok steps are not listed under the failure block.
		expect(out).not.toContain("SSO: signed out");
	});
});
