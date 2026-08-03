import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { downloadFile } from "@/lib/download.js";
import { installerArgs, runSkillOffice } from "@/lib/office.js";

const sha256 = (data: Buffer | string) =>
	createHash("sha256").update(data).digest("hex");

// 1 MiB of deterministic bytes — big enough to flow through the stream
// pipeline in multiple chunks.
const PAYLOAD = Buffer.alloc(1024 * 1024, "codev-office-test-");
const PAYLOAD_SHA = sha256(PAYLOAD);

let tempDir: string;
let server: Server;
let baseUrl: string;
// Range header seen per request path, in arrival order.
let rangeLog: (string | undefined)[];
// When true the server ignores Range and always sends the full body with 200.
let ignoreRange = false;
// Extra objects (path -> body) the server should serve.
let objects: Map<string, Buffer>;

beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-download-"));
	rangeLog = [];
	ignoreRange = false;
	objects = new Map([["/payload.bin", PAYLOAD]]);
	server = createServer((req, res) => {
		const body = objects.get(req.url ?? "");
		if (!body) {
			res.writeHead(404).end();
			return;
		}
		const range = req.headers.range;
		rangeLog.push(range);
		if (range && !ignoreRange) {
			const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
			if (!Number.isFinite(start) || start >= body.length) {
				res.writeHead(416).end();
				return;
			}
			const rest = body.subarray(start);
			res.writeHead(206, {
				"Content-Length": String(rest.length),
				"Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
			});
			res.end(rest);
			return;
		}
		res.writeHead(200, { "Content-Length": String(body.length) });
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
	rmSync(tempDir, { recursive: true, force: true });
});

describe("downloadFile", () => {
	test("downloads, verifies, and renames the partial away", async () => {
		const dest = join(tempDir, "payload.bin");
		const progress: number[] = [];
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			sha256: PAYLOAD_SHA,
			endpoint: "test.download",
			onProgress: (p) => progress.push(p.received),
		});
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
		expect(existsSync(`${dest}.partial`)).toBe(false);
		expect(progress.at(-1)).toBe(PAYLOAD.length);
	});

	test("is a no-op when the destination already verifies", async () => {
		const dest = join(tempDir, "payload.bin");
		writeFileSync(dest, PAYLOAD);
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			sha256: PAYLOAD_SHA,
			endpoint: "test.download",
		});
		// No request reached the server at all.
		expect(rangeLog).toEqual([]);
	});

	test("throws on hash mismatch and removes the partial", async () => {
		const dest = join(tempDir, "payload.bin");
		await expect(
			downloadFile({
				url: `${baseUrl}/payload.bin`,
				dest,
				sha256: "0".repeat(64),
				endpoint: "test.download",
			}),
		).rejects.toThrow(/SHA-256 mismatch/);
		expect(existsSync(dest)).toBe(false);
		expect(existsSync(`${dest}.partial`)).toBe(false);
	});

	test("resumes from a .partial via Range and still verifies", async () => {
		const dest = join(tempDir, "payload.bin");
		const HEAD = 100_000;
		writeFileSync(`${dest}.partial`, PAYLOAD.subarray(0, HEAD));
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			sha256: PAYLOAD_SHA,
			endpoint: "test.download",
		});
		expect(rangeLog).toEqual([`bytes=${HEAD}-`]);
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
	});

	test("restarts cleanly when the server ignores Range", async () => {
		ignoreRange = true;
		const dest = join(tempDir, "payload.bin");
		writeFileSync(`${dest}.partial`, Buffer.from("stale-garbage"));
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			sha256: PAYLOAD_SHA,
			endpoint: "test.download",
		});
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
	});

	test("scraps an oversized stale partial (416) and refetches", async () => {
		const dest = join(tempDir, "payload.bin");
		writeFileSync(`${dest}.partial`, Buffer.alloc(PAYLOAD.length + 10, 1));
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			sha256: PAYLOAD_SHA,
			endpoint: "test.download",
		});
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
	});

	test("fails with the HTTP status on a missing object", async () => {
		await expect(
			downloadFile({
				url: `${baseUrl}/nope.bin`,
				dest: join(tempDir, "nope.bin"),
				endpoint: "test.download",
			}),
		).rejects.toThrow(/download failed \(404\)/);
	});
});

// End-to-end through runSkillOffice against the local server. The test host is
// linux/macos in CI, so the detected platform maps to one of the bash bundles.
describe("runSkillOffice", () => {
	const hostPlatform = process.platform === "darwin" ? "macos" : "ubuntu";
	const bundleName = `minimax-docx-${hostPlatform}.zip`;
	const scriptName = `codev-office-${hostPlatform}-setup.sh`;
	const BUNDLE = Buffer.from("fake-bundle-bytes");
	const SCRIPT = Buffer.from("#!/bin/sh\nexit 0\n");

	const manifest = () => ({
		schema: 1,
		version: "test-1",
		platforms: {
			ubuntu: {
				bundle: "minimax-docx-ubuntu.zip",
				script: "codev-office-ubuntu-setup.sh",
			},
			macos: {
				bundle: "minimax-docx-macos.zip",
				script: "codev-office-macos-setup.sh",
			},
			windows: {
				bundle: "minimax-docx-windows.zip",
				script: "codev-office-windows-setup.ps1",
			},
		},
		files: {
			[bundleName]: { size: BUNDLE.length, sha256: sha256(BUNDLE) },
			[scriptName]: { size: SCRIPT.length, sha256: sha256(SCRIPT) },
		},
	});

	beforeEach(() => {
		objects.set("/manifest.json", Buffer.from(JSON.stringify(manifest())));
		objects.set(`/${bundleName}`, BUNDLE);
		objects.set(`/${scriptName}`, SCRIPT);
	});

	test("--download-only stages both files and never spawns", async () => {
		const dir = join(tempDir, "office");
		const spawns: string[] = [];
		const code = await runSkillOffice(
			["--download-only", "--dir", dir],
			baseUrl,
			async (command) => {
				spawns.push(command);
				return 0;
			},
		);
		expect(code).toBe(0);
		expect(spawns).toEqual([]);
		expect(readFileSync(join(dir, bundleName)).equals(BUNDLE)).toBe(true);
		expect(readFileSync(join(dir, scriptName)).equals(SCRIPT)).toBe(true);
	});

	test("runs the installer via bash with translated flags", async () => {
		const dir = join(tempDir, "office");
		let spawned: { command: string; args: string[]; cwd: string } | null = null;
		const code = await runSkillOffice(
			["--dir", dir, "--minimal", "--skip-verify"],
			baseUrl,
			async (command, args, cwd) => {
				spawned = { command, args, cwd };
				return 0;
			},
		);
		expect(code).toBe(0);
		expect(spawned).toEqual({
			command: "bash",
			args: [join(dir, scriptName), "--minimal", "--skip-verify"],
			cwd: dir,
		});
	});

	test("propagates the installer's exit code", async () => {
		const dir = join(tempDir, "office");
		const code = await runSkillOffice(["--dir", dir], baseUrl, async () => 7);
		expect(code).toBe(7);
	});

	test("a cross-platform --platform forces download-only", async () => {
		// The windows files are not even published on the test server: proving
		// they were requested-and-downloaded but the installer never ran.
		objects.set("/minimax-docx-windows.zip", BUNDLE);
		objects.set("/codev-office-windows-setup.ps1", SCRIPT);
		objects.set(
			"/manifest.json",
			Buffer.from(
				JSON.stringify({
					...manifest(),
					files: {
						"minimax-docx-windows.zip": {
							size: BUNDLE.length,
							sha256: sha256(BUNDLE),
						},
						"codev-office-windows-setup.ps1": {
							size: SCRIPT.length,
							sha256: sha256(SCRIPT),
						},
					},
				}),
			),
		);
		const dir = join(tempDir, "office");
		const spawns: string[] = [];
		const code = await runSkillOffice(
			["--platform", "windows", "--dir", dir],
			baseUrl,
			async (command) => {
				spawns.push(command);
				return 0;
			},
		);
		expect(code).toBe(0);
		expect(spawns).toEqual([]);
		expect(existsSync(join(dir, "minimax-docx-windows.zip"))).toBe(true);
	});

	test("fails cleanly when the manifest is missing", async () => {
		objects.delete("/manifest.json");
		const code = await runSkillOffice(
			["--dir", join(tempDir, "office")],
			baseUrl,
		);
		expect(code).toBe(1);
	});
});

describe("installerArgs", () => {
	const base = { downloadOnly: false, minimal: true, skipVerify: true };

	test("bash platforms get GNU-style flags", () => {
		expect(installerArgs(base, "ubuntu")).toEqual([
			"--minimal",
			"--skip-verify",
		]);
	});

	test("windows gets PowerShell switches", () => {
		expect(installerArgs(base, "windows")).toEqual(["-Minimal", "-SkipVerify"]);
	});

	test("no flags when none requested", () => {
		expect(
			installerArgs(
				{ downloadOnly: false, minimal: false, skipVerify: false },
				"windows",
			),
		).toEqual([]);
	});
});
