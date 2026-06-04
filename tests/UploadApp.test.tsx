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

describe("UploadApp", () => {
	test("offers paste-back when a fresh login is needed, and submits the URL", async () => {
		const submit = vi.fn((_pasted: string) => null);
		vi.spyOn(upload, "runUpload").mockImplementation((opts) => {
			return new Promise<upload.UploadSummary>((resolve) => {
				opts?.onStatus?.("Logging in...");
				opts?.onLoginUrl?.("https://sso.test/authorize?x=1");
				opts?.onManualSubmit?.((pasted) => {
					const err = submit(pasted);
					if (!err) resolve(EMPTY_SUMMARY);
					return err;
				});
			});
		});

		const { stdin, lastFrame } = render(<UploadApp />);
		await new Promise((r) => setTimeout(r, 50));

		// The paste-back affordance is shown alongside the manual URL.
		expect(lastFrame() ?? "").toContain("remote or headless");

		stdin.write("http://127.0.0.1:5000/callback?code=abc&state=xyz");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(submit).toHaveBeenCalledWith(
			expect.stringContaining("code=abc&state=xyz"),
		);
	});

	test("surfaces an inline paste error and recovers on re-submit", async () => {
		let calls = 0;
		vi.spyOn(upload, "runUpload").mockImplementation((opts) => {
			return new Promise<upload.UploadSummary>((resolve) => {
				opts?.onLoginUrl?.("https://sso.test/authorize?x=1");
				opts?.onManualSubmit?.(() => {
					calls += 1;
					if (calls === 1) return "State mismatch — use the latest URL.";
					resolve(EMPTY_SUMMARY);
					return null;
				});
			});
		});

		const { stdin, lastFrame } = render(<UploadApp />);
		await new Promise((r) => setTimeout(r, 50));

		stdin.write("oops");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));
		expect(lastFrame() ?? "").toContain("State mismatch");

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));
		expect(calls).toBe(2);
	});

	test("shows no paste field when already authenticated", async () => {
		vi.spyOn(upload, "runUpload").mockResolvedValue({
			...EMPTY_SUMMARY,
			found: 2,
			uploaded: 2,
		});

		const { lastFrame } = render(<UploadApp />);
		await new Promise((r) => setTimeout(r, 50));

		expect(lastFrame() ?? "").not.toContain("remote or headless");
	});
});
