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
import { BackgroundUploadApp } from "@/BackgroundUploadApp.js";

let tempHome: string;
let projectCwd: string;
let homedirSpy: ReturnType<typeof spyOn>;
let cwdSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-bg-upload-")));
	projectCwd = join(tempHome, "project");
	mkdirSync(projectCwd, { recursive: true });
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	cwdSpy = spyOn(process, "cwd").mockReturnValue(projectCwd);
	process.env.CODEV_SUPABASE_URL = "https://test.supabase.co";
	process.env.CODEV_SUPABASE_ANON_KEY = "anon";
});

afterEach(() => {
	cleanup();
	homedirSpy.mockRestore();
	cwdSpy.mockRestore();
	fetchSpy?.mockRestore();
	fetchSpy = null;
	rmSync(tempHome, { recursive: true, force: true });
	delete process.env.CODEV_SUPABASE_URL;
	delete process.env.CODEV_SUPABASE_ANON_KEY;
});

function writeAuth() {
	mkdirSync(join(tempHome, ".codev"), { recursive: true });
	writeFileSync(
		join(tempHome, ".codev", "auth.json"),
		JSON.stringify({
			access_token: "token",
			id_token: "token",
			expires_at: Date.now() + 3600000,
			user: { sub: "u", email: "u@example.com", displayName: "User" },
		}),
	);
}

function stubAllFetchOk() {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
	) => {
		const url =
			typeof input === "string" || input instanceof URL
				? String(input)
				: input.url;
		if (url.includes("/api/codev/supabase/exchange")) {
			return new Response(
				JSON.stringify({
					access_token: "supabase-upload-token",
					user: { id: "u", email: "u@example.com" },
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/rest/v1/conversations")) {
			return new Response("[]", {
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("ok", { status: 200 });
	}) as typeof fetch);
}

describe("BackgroundUploadApp", () => {
	test("renders only the spinner label while running", async () => {
		writeAuth();
		stubAllFetchOk();
		const { frames } = render(<BackgroundUploadApp label="Starting..." />);
		await new Promise((r) => setTimeout(r, 50));

		const earlyFrame = frames.find((f) => f.includes("Starting..."));
		expect(earlyFrame).toBeDefined();
		expect(earlyFrame).not.toContain("Uploaded");
		expect(earlyFrame).not.toContain("Source:");
	});

	test("does not render the verbose summary on completion", async () => {
		writeAuth();
		stubAllFetchOk();
		const { frames } = render(<BackgroundUploadApp label="Stopping..." />);
		await new Promise((r) => setTimeout(r, 250));

		const meaningful = frames.filter((f) => f.trim().length > 0);
		const lastFrame = meaningful[meaningful.length - 1] ?? "";
		expect(lastFrame).not.toContain("Uploaded");
		expect(lastFrame).not.toContain("Skipped");
		expect(lastFrame).not.toContain("Source:");
	});

	test("swallows upload errors silently", async () => {
		writeAuth();
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			_input: string | URL | Request,
		) => {
			return new Response("boom", { status: 500 });
		}) as typeof fetch);
		const { frames } = render(<BackgroundUploadApp label="Stopping..." />);
		await new Promise((r) => setTimeout(r, 250));

		const all = frames.join("\n");
		expect(all).not.toContain("Upload failed");
		expect(all).not.toContain("error");
	});
});
