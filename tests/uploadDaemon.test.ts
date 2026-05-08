import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUploadDaemon, spawner, spawnUploadDaemon } from "@/lib/upload.js";

let tempHome: string;
let projectCwd: string;
let homedirSpy: ReturnType<typeof spyOn>;
let cwdSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-upload-daemon-")));
	projectCwd = join(tempHome, "project");
	mkdirSync(projectCwd, { recursive: true });
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	cwdSpy = spyOn(process, "cwd").mockReturnValue(projectCwd);
});

afterEach(() => {
	homedirSpy.mockRestore();
	cwdSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
	(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
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
			supabase_url: "https://test.supabase.co",
			supabase_anon_key: "anon",
			supabase_proxy_url: "https://api.test/api/codev",
		}),
	);
}

function writeLog(name = "a.md", content = "hello") {
	const dir = join(tempHome, ".codev", "logs", "project", "codex");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function mockUploadHappyPath() {
	spyOn(globalThis, "fetch").mockImplementation((async (
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
		if (url.includes("/functions/v1/presign-upload")) {
			return new Response(
				JSON.stringify({
					uploadUrl: "https://upload.example.com/file",
					conversationId: "cid",
					storagePath: "u/cid/new.md",
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		if (url === "https://upload.example.com/file") {
			return new Response("", { status: 200 });
		}
		if (url.includes("/functions/v1/confirm-upload")) {
			return new Response(JSON.stringify({ ok: true }));
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch);
}

const lockPath = () => join(tempHome, ".codev", "upload.lock");
const logPath = () => join(tempHome, ".codev", "upload.log");
const statusPath = () => join(tempHome, ".codev", "last-upload.json");

describe("runUploadDaemon", () => {
	test("skips silently when not logged in", async () => {
		const code = await runUploadDaemon();
		expect(code).toBe(0);
		expect(readFileSync(logPath(), "utf-8")).toContain(
			"Skipped: not logged in.",
		);
		expect(existsSync(statusPath())).toBe(false);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("skips when lockfile is held by an alive process", async () => {
		writeAuth();
		mkdirSync(join(tempHome, ".codev"), { recursive: true });
		writeFileSync(
			lockPath(),
			JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
			}),
		);
		const code = await runUploadDaemon();
		expect(code).toBe(0);
		expect(readFileSync(logPath(), "utf-8")).toContain(
			"another upload is in progress",
		);
		expect(existsSync(statusPath())).toBe(false);
		// Lock belongs to someone else (here, ourselves) — must not be released.
		expect(existsSync(lockPath())).toBe(true);
	});

	test("reclaims a stale lock past STALE_LOCK_MS and proceeds", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		mkdirSync(join(tempHome, ".codev"), { recursive: true });
		writeFileSync(
			lockPath(),
			JSON.stringify({
				pid: process.pid,
				startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			}),
		);
		mockUploadHappyPath();
		const code = await runUploadDaemon();
		expect(code).toBe(0);
		const status = JSON.parse(readFileSync(statusPath(), "utf-8"));
		expect(status.ok).toBe(true);
		expect(status.summary.uploaded).toBe(1);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("reclaims a corrupt lockfile and proceeds", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		mkdirSync(join(tempHome, ".codev"), { recursive: true });
		writeFileSync(lockPath(), "not json");
		mockUploadHappyPath();
		const code = await runUploadDaemon();
		expect(code).toBe(0);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("happy path writes ok=true status, releases lock, logs Done", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		mockUploadHappyPath();
		const code = await runUploadDaemon();
		expect(code).toBe(0);
		const status = JSON.parse(readFileSync(statusPath(), "utf-8"));
		expect(status.ok).toBe(true);
		expect(status.summary.found).toBe(1);
		expect(status.summary.uploaded).toBe(1);
		expect(status.summary.skipped).toBe(0);
		expect(status.summary.failed).toBe(0);
		expect(status.errors).toBeUndefined();
		expect(typeof status.startedAt).toBe("string");
		expect(typeof status.finishedAt).toBe("string");
		expect(readFileSync(logPath(), "utf-8")).toContain(
			"Done: uploaded=1 skipped=0 failed=0",
		);
		expect(existsSync(lockPath())).toBe(false);
	});

	test("supabase exchange failure writes ok=false status, releases lock", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/api/codev/supabase/exchange")) {
				return new Response(JSON.stringify({ error: "nope" }), {
					status: 401,
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);
		const code = await runUploadDaemon();
		expect(code).toBe(1);
		const status = JSON.parse(readFileSync(statusPath(), "utf-8"));
		expect(status.ok).toBe(false);
		expect(status.error).toContain("Proxy /supabase/exchange failed");
		expect(status.summary).toBeUndefined();
		expect(readFileSync(logPath(), "utf-8")).toContain("Failed:");
		expect(existsSync(lockPath())).toBe(false);
	});

	test("per-file upload failure leaves ok=false with errors and releases lock", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/api/codev/supabase/exchange")) {
				return new Response(
					JSON.stringify({
						access_token: "x",
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
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response("boom", {
					status: 500,
					statusText: "Server Error",
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);
		const code = await runUploadDaemon();
		expect(code).toBe(1);
		const status = JSON.parse(readFileSync(statusPath(), "utf-8"));
		expect(status.ok).toBe(false);
		expect(status.summary.failed).toBe(1);
		expect(status.summary.uploaded).toBe(0);
		expect(status.errors).toHaveLength(1);
		expect(status.errors[0].file).toContain("new.md");
		expect(existsSync(lockPath())).toBe(false);
	});
});

describe("spawnUploadDaemon", () => {
	test("does not spawn when not logged in", () => {
		const spawnSpy = spyOn(spawner, "spawn");
		try {
			spawnUploadDaemon();
			expect(spawnSpy).not.toHaveBeenCalled();
			expect(existsSync(logPath())).toBe(false);
		} finally {
			spawnSpy.mockRestore();
		}
	});

	test("spawns detached, unref'd child with --daemon when logged in", () => {
		writeAuth();
		const fakeChild = { unref: () => {} } as unknown as ChildProcess;
		const unrefSpy = spyOn(fakeChild, "unref");
		const spawnSpy = spyOn(spawner, "spawn").mockReturnValue(fakeChild);
		try {
			spawnUploadDaemon();
			expect(spawnSpy).toHaveBeenCalledTimes(1);
			const call = spawnSpy.mock.calls[0] as [
				string,
				string[],
				{ detached?: boolean; stdio?: unknown[] },
			];
			const [execPath, args, opts] = call;
			expect(execPath).toBe(process.execPath);
			expect(args[args.length - 2]).toBe("upload");
			expect(args[args.length - 1]).toBe("--daemon");
			expect(opts.detached).toBe(true);
			expect(Array.isArray(opts.stdio)).toBe(true);
			expect((opts.stdio as unknown[])[0]).toBe("ignore");
			expect(unrefSpy).toHaveBeenCalledTimes(1);
			// The parent opens the log for append even when delegating to a fake child.
			expect(existsSync(logPath())).toBe(true);
		} finally {
			spawnSpy.mockRestore();
			unrefSpy.mockRestore();
		}
	});

	test("swallows spawn errors so the agent is never blocked", () => {
		writeAuth();
		const spawnSpy = spyOn(spawner, "spawn").mockImplementation(() => {
			throw new Error("EAGAIN");
		});
		try {
			expect(() => spawnUploadDaemon()).not.toThrow();
		} finally {
			spawnSpy.mockRestore();
		}
	});
});
