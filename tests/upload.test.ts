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
import {
	fileSha256,
	filterNewFiles,
	isRefreshableError,
	listMarkdownLogs,
	runUpload,
} from "@/lib/upload.js";

let tempHome: string;
let projectCwd: string;
let homedirSpy: ReturnType<typeof spyOn>;
let cwdSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-upload-")));
	projectCwd = join(tempHome, "project");
	mkdirSync(projectCwd, { recursive: true });
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	cwdSpy = spyOn(process, "cwd").mockReturnValue(projectCwd);
});

afterEach(() => {
	homedirSpy.mockRestore();
	cwdSpy.mockRestore();
	rmSync(tempHome, { recursive: true, force: true });
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

describe("upload helpers", () => {
	test("lists markdown logs under agent directories only", () => {
		const path = writeLog();
		writeFileSync(
			join(tempHome, ".codev", "logs", "project", "statistics.json"),
			"{}",
		);
		expect(
			listMarkdownLogs(join(tempHome, ".codev", "logs", "project")),
		).toEqual([path]);
	});

	test("hashes and filters unchanged files", () => {
		const path = writeLog("same.md", "same");
		const abs = realpathSync(path);
		const hash = fileSha256(path);
		const existing = new Map([
			[
				abs,
				{
					id: "prev",
					local_file_path: abs,
					local_content_hash: hash,
					uploaded_at: null,
				},
			],
		]);
		expect(filterNewFiles([path], existing)).toEqual([]);
	});

	test("keeps changed files with previous version id", () => {
		const path = writeLog("changed.md", "new");
		const abs = realpathSync(path);
		const existing = new Map([
			[
				abs,
				{
					id: "prev",
					local_file_path: abs,
					local_content_hash: "old",
					uploaded_at: null,
				},
			],
		]);
		const result = filterNewFiles([path], existing);
		expect(result).toHaveLength(1);
		expect(result[0]?.previousVersionId).toBe("prev");
	});
});

describe("runUpload", () => {
	test("presigns, uploads, and confirms new logs", async () => {
		writeAuth();
		writeLog("new.md", "hello");
		const calls: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			calls.push(url);
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
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer supabase-upload-token",
				);
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
				expect(init?.method).toBe("PUT");
				expect(
					(init?.headers as Record<string, string>)["Content-Encoding"],
				).toBe("gzip");
				return new Response("", { status: 200 });
			}
			if (url.includes("/functions/v1/confirm-upload")) {
				const body = JSON.parse(String(init?.body));
				expect(body.encoding).toBe("gzip");
				expect(body.localContentHash).toBeTruthy();
				return new Response(JSON.stringify({ ok: true }));
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			const summary = await runUpload();
			expect(summary.uploaded).toBe(1);
			expect(summary.failed).toBe(0);
			expect(calls.some((c) => c.includes("presign-upload"))).toBe(true);
			expect(calls.some((c) => c.includes("confirm-upload"))).toBe(true);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("refreshes config and retries when Supabase returns 401", async () => {
		writeAuth();
		writeLog("retry.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;

			// codev-proxy /config: hand back fresh Supabase coords on refresh.
			if (url.includes("/codev-proxy/config")) {
				configCalls++;
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://test.supabase.co",
						supabaseAnonKey: "anon",
						supabaseProxyUrl: "https://api.test/api/codev",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
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
				conversationCalls++;
				if (conversationCalls === 1) {
					return new Response("unauthorized", { status: 401 });
				}
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/retry.md",
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

		try {
			const summary = await runUpload();
			expect(summary.uploaded).toBe(1);
			expect(summary.failed).toBe(0);
			expect(conversationCalls).toBe(2);
			expect(configCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("does not retry on Supabase 5xx errors", async () => {
		writeAuth();
		writeLog("nope.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-proxy/config")) {
				configCalls++;
				return new Response("{}", {
					headers: { "Content-Type": "application/json" },
				});
			}
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
				conversationCalls++;
				return new Response("internal error", { status: 503 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			await expect(runUpload()).rejects.toThrow(/conversations API failed/);
			expect(conversationCalls).toBe(1);
			expect(configCalls).toBe(0);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("refreshes config when Supabase coords are missing from cache", async () => {
		// Auth file with SSO tokens but no supabase_* fields.
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
		writeLog("first.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-proxy/config")) {
				configCalls++;
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://fresh.supabase.co",
						supabaseAnonKey: "fresh-anon",
						supabaseProxyUrl: "https://api.test/api/codev",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
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
				conversationCalls++;
				return new Response("[]", {
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/functions/v1/presign-upload")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://upload.example.com/file",
						conversationId: "cid",
						storagePath: "u/cid/first.md",
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

		try {
			const summary = await runUpload();
			expect(summary.uploaded).toBe(1);
			expect(summary.failed).toBe(0);
			expect(configCalls).toBe(1);
			expect(conversationCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("propagates the second error if refresh-and-retry also fails", async () => {
		writeAuth();
		writeLog("doomed.md", "hello");

		let configCalls = 0;
		let conversationCalls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url =
				typeof input === "string" || input instanceof URL
					? String(input)
					: input.url;
			if (url.includes("/codev-proxy/config")) {
				configCalls++;
				return new Response(
					JSON.stringify({
						supabaseUrl: "https://test.supabase.co",
						supabaseAnonKey: "anon",
						supabaseProxyUrl: "https://api.test/api/codev",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
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
				conversationCalls++;
				return new Response("still-bad", { status: 401 });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch);

		try {
			await expect(runUpload()).rejects.toThrow(/conversations API failed/);
			expect(conversationCalls).toBe(2);
			expect(configCalls).toBe(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("isRefreshableError", () => {
	test("true when supabase coords are missing from auth.json", () => {
		expect(
			isRefreshableError(
				new Error(
					"Missing supabase_url in ~/.codev/auth.json. Run `codev install`...",
				),
			),
		).toBe(true);
	});

	test("true on HTTP 401", () => {
		expect(
			isRefreshableError(
				new Error("conversations API failed (401): unauthorized"),
			),
		).toBe(true);
	});

	test("true on HTTP 403", () => {
		expect(
			isRefreshableError(new Error("presign-upload failed (403): forbidden")),
		).toBe(true);
	});

	test("false on HTTP 500", () => {
		expect(
			isRefreshableError(new Error("conversations API failed (500): boom")),
		).toBe(false);
	});

	test("false on HTTP 404", () => {
		expect(
			isRefreshableError(
				new Error("Proxy /supabase/exchange failed (404): Not found"),
			),
		).toBe(false);
	});

	test("false on network errors", () => {
		expect(isRefreshableError(new Error("fetch failed: ECONNREFUSED"))).toBe(
			false,
		);
	});

	test("false on non-Error values", () => {
		expect(isRefreshableError("random string")).toBe(false);
		expect(isRefreshableError(null)).toBe(false);
	});
});
