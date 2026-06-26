import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as upload from "@/lib/upload.js";
import { UploadApp } from "@/UploadApp.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const EMPTY_SUMMARY: upload.UploadSummary = {
	outDir: "/tmp/logs",
	found: 0,
	uploaded: 0,
	skipped: 0,
	failed: 0,
	errors: [],
};

// Poll until `predicate` holds. Used instead of a fixed sleep because Ink
// attaches its input listener a beat after the paste field first paints (a
// useEffect gated on isActive), and that lag is larger on Windows CI.
async function waitFor(predicate: () => boolean, tries = 100): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("waitFor: condition not met within timeout");
}

// Paste `value` then press Enter until `predicate` holds. Keystrokes written
// before Ink's input listener is attached are silently dropped, so retrying
// makes the test independent of that activation timing (the source of the
// Windows-only race). An empty-field Enter is a no-op in the paste-back hook, so
// a value must accompany each submit attempt.
async function pasteAndSubmitUntil(
	stdin: { write: (data: string) => void },
	value: string,
	predicate: () => boolean,
	tries = 100,
): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		stdin.write(value);
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("pasteAndSubmitUntil: condition not met within timeout");
}

describe("UploadApp", () => {
	test("offers paste-back when a fresh login is needed and submits on Enter", async () => {
		const submit = vi.fn();
		vi.spyOn(upload, "runUpload").mockImplementation((opts) => {
			return new Promise<upload.UploadSummary>((resolve) => {
				opts?.onLoginUrl?.("https://sso.test/authorize?x=1");
				opts?.onManualSubmit?.((pasted) => {
					submit(pasted);
					resolve(EMPTY_SUMMARY);
					return null;
				});
			});
		});

		const { stdin, lastFrame } = render(<UploadApp />);

		// The paste-back affordance is offered alongside the manual URL.
		await waitFor(() => (lastFrame() ?? "").includes("authorization code"));

		// A pasted value + Enter reaches the submitter that runUpload wired in
		// (verifying the onManualSubmit plumbing). Exact char accumulation is
		// covered cross-platform by the Login component tests.
		await pasteAndSubmitUntil(
			stdin,
			"http://127.0.0.1:5000/callback?code=abc&state=xyz",
			() => submit.mock.calls.length > 0,
		);
		expect(submit).toHaveBeenCalled();
	});

	test("renders an inline error when a submitted paste is rejected", async () => {
		vi.spyOn(upload, "runUpload").mockImplementation((opts) => {
			// Never resolves: every submit is rejected, mirroring a stuck login.
			return new Promise<upload.UploadSummary>(() => {
				opts?.onLoginUrl?.("https://sso.test/authorize?x=1");
				opts?.onManualSubmit?.(() => "State mismatch — use the latest URL.");
			});
		});

		const { stdin, lastFrame } = render(<UploadApp />);
		await waitFor(() => (lastFrame() ?? "").includes("authorization code"));
		await pasteAndSubmitUntil(
			stdin,
			"http://127.0.0.1:5000/callback?code=abc&state=xyz",
			() => (lastFrame() ?? "").includes("State mismatch"),
		);
		expect(lastFrame() ?? "").toContain("State mismatch");
	});

	test("shows no paste field when already authenticated", async () => {
		const runUpload = vi.spyOn(upload, "runUpload").mockResolvedValue({
			...EMPTY_SUMMARY,
			found: 2,
			uploaded: 2,
		});

		const { lastFrame } = render(<UploadApp />);
		// runUpload resolves without ever calling onLoginUrl, so the field can
		// never appear; give the async chain a moment, then assert its absence.
		await waitFor(() => runUpload.mock.calls.length > 0);
		await new Promise((r) => setTimeout(r, 50));
		expect(lastFrame() ?? "").not.toContain("authorization code");
	});

	test("explains where it looked when no conversations are found", async () => {
		vi.spyOn(upload, "runUpload").mockResolvedValue({
			...EMPTY_SUMMARY,
			found: 0,
			targets: [
				{
					agent: "claude-code",
					path: "C:\\Users\\me\\.claude\\projects\\D--x",
				},
				{ agent: "codex", path: "C:\\Users\\me\\.codex\\sessions" },
			],
		});

		// The component exit()s the moment the summary renders, which can unmount
		// before lastFrame() is next polled — so assert against the captured frame
		// history, where the summary frame persists regardless of unmount timing.
		const { frames } = render(<UploadApp />);
		const painted = () => frames.join("\n");
		await waitFor(() => painted().includes("No conversations found"));
		const out = painted();
		expect(out).toContain("codev looked in:");
		expect(out).toContain("claude-code: C:\\Users\\me\\.claude\\projects\\D--x");
		expect(out).toContain("codex: C:\\Users\\me\\.codex\\sessions");
		expect(out).toContain("launched it from this directory");
		// The empty result is not dressed up as a successful upload.
		expect(out).not.toContain("Uploaded 0/0");
	});

	test("dismisses the login prompt once login completes via the browser", async () => {
		// Browser-login path: onLoginUrl raises the prompt, then onLoginDone fires
		// when the loopback callback completes — without any paste. The URL +
		// paste-back prompt must come down instead of lingering while the upload
		// proceeds (the bug: only the manual-paste path used to hide them).
		let finishLogin: (() => void) | undefined;
		let resolveUpload: ((s: upload.UploadSummary) => void) | undefined;
		vi.spyOn(upload, "runUpload").mockImplementation((opts) => {
			return new Promise<upload.UploadSummary>((resolve) => {
				opts?.onLoginUrl?.("https://sso.test/authorize?x=1");
				opts?.onManualSubmit?.(() => null);
				finishLogin = opts?.onLoginDone;
				resolveUpload = resolve;
			});
		});

		const { lastFrame } = render(<UploadApp />);
		// Prompt is up while login is pending.
		await waitFor(() => (lastFrame() ?? "").includes("authorization code"));

		// Browser login completes (no paste) — the prompt + URL must disappear.
		finishLogin?.();
		await waitFor(() => !(lastFrame() ?? "").includes("authorization code"));
		expect(lastFrame() ?? "").not.toContain("authorization code");
		expect(lastFrame() ?? "").not.toContain("authorize?x=1");

		// Let the upload finish so the component unmounts cleanly.
		resolveUpload?.(EMPTY_SUMMARY);
		await new Promise((r) => setTimeout(r, 20));
	});
});
