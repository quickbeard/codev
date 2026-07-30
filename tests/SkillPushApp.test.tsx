import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as auth from "@/lib/auth.js";
import * as publish from "@/lib/skill-publish.js";
import * as skillhub from "@/lib/skillhub.js";
import { SkillPushApp } from "@/SkillPushApp.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) =>
	s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

type Frame = () => string | undefined;
type Stdin = { write: (s: string) => void };
const frameText = (lastFrame: Frame) => stripAnsi(lastFrame() ?? "");

async function waitFor(predicate: () => boolean, tries = 200): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("waitFor: condition not met within timeout");
}

// Keystrokes written before Ink attaches its input listener are dropped, so
// retry sending the answer until the confirm prompt is left behind.
async function answerConfirm(
	stdin: Stdin,
	lastFrame: Frame,
	key: string,
	advanced: () => boolean,
): Promise<void> {
	await waitFor(() => {
		if (advanced()) return true;
		if (frameText(lastFrame).includes("Publish this skill?")) stdin.write(key);
		return false;
	});
}

const ARCHIVE: publish.PublishArchive = {
	zipBuffer: Buffer.from("z"),
	fileName: "pg-tuner.zip",
	files: ["SKILL.md"],
	totalBytes: 6,
	skipped: [],
	source: "dir",
};
const RESULT: publish.PublishResult = {
	skillId: "sk-1",
	status: "SUBMITTED",
	steps: [
		"uploaded",
		"metadata saved (DRAFT)",
		"submitted for review (SUBMITTED)",
	],
};

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-xyz",
		id_token: "id-xyz",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

function renderApp(onDone?: (ok: boolean) => void) {
	vi.spyOn(publish, "preparePublishArchive").mockResolvedValue(ARCHIVE);
	return render(
		<SkillPushApp
			path="./pg-tuner"
			json={false}
			draftOnly={false}
			autoApprove={false}
			onDone={onDone}
		/>,
	);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("SkillPushApp login gate", () => {
	test("already authenticated: shows a Signed-in step (no login prompt) and publishes", async () => {
		const authSpy = vi
			.spyOn(skillhub, "hasSkillhubAuth")
			.mockResolvedValue(true);
		vi.spyOn(auth, "loadAuth").mockReturnValue(fakeAuth());
		const loginSpy = vi.spyOn(auth, "login");
		const pub = vi.spyOn(publish, "publishSkill").mockResolvedValue(RESULT);

		const { stdin, lastFrame } = renderApp();

		await answerConfirm(stdin, lastFrame, "y", () => pub.mock.calls.length > 0);
		await waitFor(() => frameText(lastFrame).includes("Published skill sk-1"));

		const frame = frameText(lastFrame);
		expect(authSpy).toHaveBeenCalled();
		// Login step is still shown — as an already-signed-in line, no interactive
		// prompt (auth.login is never invoked).
		expect(frame).toContain("✓ Signed in as test@example.com");
		expect(loginSpy).not.toHaveBeenCalled();
	});

	test("logged out: confirm triggers the login step, then publishes", async () => {
		vi.spyOn(skillhub, "hasSkillhubAuth").mockResolvedValue(false);
		// Login component resolves immediately (no browser, no onReady) → onDone.
		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
		const pub = vi.spyOn(publish, "publishSkill").mockResolvedValue(RESULT);

		const { stdin, lastFrame } = renderApp();

		await answerConfirm(stdin, lastFrame, "y", () => pub.mock.calls.length > 0);
		await waitFor(() => pub.mock.calls.length > 0);
		await waitFor(() => frameText(lastFrame).includes("Published skill sk-1"));

		expect(loginSpy).toHaveBeenCalled();
	});

	test("keeps the preview visible when the login step appears", async () => {
		vi.spyOn(skillhub, "hasSkillhubAuth").mockResolvedValue(false);
		// Hold login pending so the app stays in the login phase.
		vi.spyOn(auth, "login").mockReturnValue(
			new Promise<auth.AuthData>(() => {}),
		);

		const { stdin, lastFrame } = renderApp();

		await answerConfirm(stdin, lastFrame, "y", () =>
			frameText(lastFrame).includes("Login"),
		);

		const frame = frameText(lastFrame);
		// Both steps on screen at once: the archive preview AND the login step.
		expect(frame).toContain("pg-tuner.zip");
		expect(frame).toContain("Upload and submit for review.");
		expect(frame).toContain("Login");
	});

	test("marks the in-flight step failed (✗) when publishing errors", async () => {
		vi.spyOn(skillhub, "hasSkillhubAuth").mockResolvedValue(true);
		// Fail mid-upload: the upload step starts, then throws.
		vi.spyOn(publish, "publishSkill").mockImplementation(
			async (_archive, _opts, onStep) => {
				onStep?.("upload", "start");
				throw new Error("A published skill named 'x' already exists.");
			},
		);
		const onDone = vi.fn();

		const { stdin, lastFrame } = renderApp(onDone);

		await answerConfirm(
			stdin,
			lastFrame,
			"y",
			() => onDone.mock.calls.length > 0,
		);

		const frame = frameText(lastFrame);
		// The failed step shows ✗ (not a frozen spinner), alongside the error.
		expect(frame).toContain("✗");
		expect(frame).toContain("Uploading");
		expect(frame).toContain("already exists");
		expect(onDone).toHaveBeenCalledWith(false);
	});

	test("cancelling at the confirm never checks auth or publishes", async () => {
		const authSpy = vi
			.spyOn(skillhub, "hasSkillhubAuth")
			.mockResolvedValue(true);
		const pub = vi.spyOn(publish, "publishSkill").mockResolvedValue(RESULT);
		const onDone = vi.fn();

		const { stdin, lastFrame } = renderApp(onDone);

		// Key off onDone, not the "Cancelled." frame: cancel exits after ~20ms,
		// too brief to observe the frame reliably.
		await answerConfirm(
			stdin,
			lastFrame,
			"n",
			() => onDone.mock.calls.length > 0,
		);

		expect(onDone).toHaveBeenCalledWith(false);
		expect(authSpy).not.toHaveBeenCalled();
		expect(pub).not.toHaveBeenCalled();
	});

	// A terminal with no raw mode (Git Bash on Windows — see lib/tty.ts). The
	// confirm step is the last thing between the user and an upload, so silence
	// must never be read as consent. ink-testing-library's stdin reports isTTY
	// true and takes no options, so the flag is flipped and the tree re-rendered
	// — Ink recomputes `isRawModeSupported` every render.
	test("without raw mode: refuses rather than publishing unconfirmed", async () => {
		const authSpy = vi
			.spyOn(skillhub, "hasSkillhubAuth")
			.mockResolvedValue(true);
		const pub = vi.spyOn(publish, "publishSkill").mockResolvedValue(RESULT);
		vi.spyOn(publish, "preparePublishArchive").mockResolvedValue(ARCHIVE);
		const onDone = vi.fn();

		const node = (
			<SkillPushApp
				path="./pg-tuner"
				json={false}
				draftOnly={false}
				autoApprove={false}
				onDone={onDone}
			/>
		);
		const instance = render(node);
		instance.stdin.isTTY = false;
		instance.rerender(node);

		await waitFor(() =>
			frameText(instance.lastFrame).includes("cannot supply keystrokes"),
		);
		expect(frameText(instance.lastFrame)).toContain("--json");
		expect(authSpy).not.toHaveBeenCalled();
		expect(pub).not.toHaveBeenCalled();
		await waitFor(() => onDone.mock.calls.length > 0);
		expect(onDone).toHaveBeenCalledWith(false);
	});
});
