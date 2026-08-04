import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
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
import {
	installerArgs,
	runSkillOffice,
	uninstallerArgs,
} from "@/lib/office.js";

const sha256 = (data: Buffer | string) =>
	createHash("sha256").update(data).digest("hex");

// runSkillOffice reads process.platform to pick the bundle and to decide whether
// the installer may run here. Restores the original descriptor rather than
// re-defining a value, so nothing leaks into the files that share this worker.
async function withPlatform<T>(
	value: NodeJS.Platform,
	fn: () => Promise<T>,
): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	try {
		return await fn();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
		else delete (process as { platform?: unknown }).platform;
	}
}

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
// When true the server sends no Content-Length (chunked), as a proxy or a
// streaming origin may.
let omitContentLength = false;
// Extra objects (path -> body) the server should serve.
let objects: Map<string, Buffer>;

beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-download-"));
	rangeLog = [];
	ignoreRange = false;
	omitContentLength = false;
	objects = new Map([["/payload.bin", PAYLOAD]]);
	server = createServer((req, res) => {
		const body = objects.get(req.url ?? "");
		if (!body) {
			res.writeHead(404).end();
			return;
		}
		// MinIO-style conditional semantics: a per-body ETag, 304 on a matching
		// If-None-Match, and Range honored only when If-Range (if sent) matches.
		const etag = `"${sha256(body).slice(0, 16)}"`;
		const range = req.headers.range;
		rangeLog.push(range);
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, { ETag: etag }).end();
			return;
		}
		const ifRange = req.headers["if-range"];
		if (range && !ignoreRange && (ifRange === undefined || ifRange === etag)) {
			const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
			if (!Number.isFinite(start) || start >= body.length) {
				res.writeHead(416).end();
				return;
			}
			const rest = body.subarray(start);
			res.writeHead(206, {
				"Content-Length": String(rest.length),
				"Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
				ETag: etag,
			});
			res.end(rest);
			return;
		}
		if (omitContentLength) {
			res.writeHead(200, { ETag: etag });
			res.end(body);
			return;
		}
		res.writeHead(200, { "Content-Length": String(body.length), ETag: etag });
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

	// `Number(res.headers.get("content-length"))` is `Number(null)` === 0 when the
	// header is absent, and 0 is finite — reading it straight makes the opts.size
	// fallback unreachable and reports a total of `offset` (0 on a fresh
	// download), which renders as Infinity%.
	test("falls back to the declared size when the server omits content-length", async () => {
		omitContentLength = true;
		const dest = join(tempDir, "payload.bin");
		const totals: (number | null)[] = [];
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			size: PAYLOAD.length,
			endpoint: "test.download",
			onProgress: (p) => totals.push(p.total),
		});
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
		expect(totals.length).toBeGreaterThan(0);
		expect(totals.every((t) => t === PAYLOAD.length)).toBe(true);
	});

	test("reports an unknown total when neither side gives a size", async () => {
		omitContentLength = true;
		const dest = join(tempDir, "payload.bin");
		const totals: (number | null)[] = [];
		await downloadFile({
			url: `${baseUrl}/payload.bin`,
			dest,
			endpoint: "test.download",
			onProgress: (p) => totals.push(p.total),
		});
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
		// null, not 0 — the progress printer branches on it to drop the percentage
		// rather than dividing by zero.
		expect(totals.every((t) => t === null)).toBe(true);
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

describe("downloadFile ETag revalidation", () => {
	test("a finished file is kept when the server answers 304", async () => {
		const dest = join(tempDir, "payload.bin");
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		const before = rangeLog.length;
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
		// Exactly one request: the conditional probe, no re-download.
		expect(rangeLog.length).toBe(before + 1);
	});

	test("a republished object is re-downloaded (ETag mismatch)", async () => {
		const dest = join(tempDir, "payload.bin");
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		const NEW = Buffer.from("republished-bytes");
		objects.set("/payload.bin", NEW);
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		expect(readFileSync(dest).equals(NEW)).toBe(true);
	});

	test("a file with no ETag on record is trusted without any request", async () => {
		const dest = join(tempDir, "payload.bin");
		writeFileSync(dest, "manually-placed");
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		expect(readFileSync(dest, "utf8")).toBe("manually-placed");
		expect(rangeLog).toEqual([]);
	});

	test("a resume across a republish restarts instead of splicing (If-Range)", async () => {
		const dest = join(tempDir, "payload.bin");
		// A partial and ETag from an older publish of the object.
		writeFileSync(`${dest}.partial`, Buffer.from("stale-old-bytes"));
		writeFileSync(`${dest}.etag`, '"stale-etag"');
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		// If-Range mismatched → server sent 200 → clean restart, correct bytes.
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
	});
});

// End-to-end through runSkillOffice against the local server. The test host is
// linux/macos in CI, so the detected platform maps to one of the bash bundles.
// File names are the deterministic per-platform contract — no manifest.
describe("runSkillOffice", () => {
	const hostPlatform = process.platform === "darwin" ? "macos" : "ubuntu";
	const bundleName = `codev-office-${hostPlatform}.zip`;
	const scriptName = `codev-office-${hostPlatform}-setup.sh`;
	const BUNDLE = Buffer.from("fake-bundle-bytes");
	const SCRIPT = Buffer.from("#!/bin/sh\nexit 0\n");

	beforeEach(() => {
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
		objects.set("/codev-office-windows.zip", BUNDLE);
		objects.set("/codev-office-windows-setup.ps1", SCRIPT);
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
		expect(existsSync(join(dir, "codev-office-windows.zip"))).toBe(true);
	});

	test("always refetches the setup script, but reuses a finished bundle", async () => {
		const dir = join(tempDir, "office");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, scriptName), "stale-script");
		writeFileSync(join(dir, bundleName), "stale-bundle");
		const code = await runSkillOffice(
			["--download-only", "--dir", dir],
			baseUrl,
		);
		expect(code).toBe(0);
		expect(readFileSync(join(dir, scriptName)).equals(SCRIPT)).toBe(true);
		// No checksum to disagree with, so the existing bundle is trusted as-is.
		expect(readFileSync(join(dir, bundleName), "utf8")).toBe("stale-bundle");
	});

	// The other half of "always refetch the script": deleting the finished file
	// alone still leaves downloadFile resuming from a leftover .partial via Range,
	// and no checksum is passed that could catch the splice.
	test("drops a stale .partial for the script instead of resuming onto it", async () => {
		const dir = join(tempDir, "office");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${scriptName}.partial`), "##");
		const code = await runSkillOffice(
			["--download-only", "--dir", dir],
			baseUrl,
		);
		expect(code).toBe(0);
		expect(readFileSync(join(dir, scriptName)).equals(SCRIPT)).toBe(true);
		// Both requests went out without a Range header.
		expect(rangeLog).toEqual([undefined, undefined]);
	});

	// The PowerShell branch is unreachable from a non-Windows host — a
	// cross-platform --platform forces download-only — so the host is stubbed to
	// keep the argv shape pinned on the Linux/macOS machines that run this suite.
	test("runs the PowerShell installer on a Windows host", async () => {
		objects.set("/codev-office-windows.zip", BUNDLE);
		objects.set("/codev-office-windows-setup.ps1", SCRIPT);
		const dir = join(tempDir, "office");
		let spawned: { command: string; args: string[]; cwd: string } | null = null;
		const code = await withPlatform("win32", () =>
			runSkillOffice(
				["--dir", dir, "--minimal", "--skip-verify"],
				baseUrl,
				async (command, args, cwd) => {
					spawned = { command, args, cwd };
					return 0;
				},
			),
		);
		expect(code).toBe(0);
		expect(spawned).toEqual({
			command: "powershell.exe",
			args: [
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(dir, "codev-office-windows-setup.ps1"),
				"-Minimal",
				"-SkipVerify",
			],
			cwd: dir,
		});
	});

	test("exits 1 on an OS with no bundle and downloads nothing", async () => {
		const code = await withPlatform("freebsd", () =>
			runSkillOffice(["--dir", join(tempDir, "office")], baseUrl),
		);
		expect(code).toBe(1);
		expect(rangeLog).toEqual([]);
	});

	test("exits 1 on an unknown flag and downloads nothing", async () => {
		expect(await runSkillOffice(["--wat"], baseUrl)).toBe(1);
		expect(rangeLog).toEqual([]);
	});

	test("fails cleanly when the bundle is not published", async () => {
		objects.delete(`/${bundleName}`);
		const code = await runSkillOffice(
			["--dir", join(tempDir, "office")],
			baseUrl,
		);
		expect(code).toBe(1);
	});

	test("--uninstall fetches only the uninstall script and runs it with passthroughs", async () => {
		const uninstallName = `codev-office-${hostPlatform}-uninstall.sh`;
		objects.set(`/${uninstallName}`, SCRIPT);
		const dir = join(tempDir, "office");
		let spawned: { command: string; args: string[] } | null = null;
		const code = await runSkillOffice(
			["--uninstall", "--yes", "--skills-only", "--dir", dir],
			baseUrl,
			async (command, args) => {
				spawned = { command, args };
				return 0;
			},
		);
		expect(code).toBe(0);
		expect(spawned).toEqual({
			command: "bash",
			args: [join(dir, uninstallName), "--yes", "--skills-only"],
		});
		// The bundle is never touched in uninstall mode.
		expect(existsSync(join(dir, bundleName))).toBe(false);
	});
});

const NO_FLAGS = {
	downloadOnly: false,
	minimal: false,
	skipVerify: false,
	forceSkills: false,
	uninstall: false,
	yes: false,
	skillsOnly: false,
	purgeDownloads: false,
};

describe("installerArgs", () => {
	const base = {
		...NO_FLAGS,
		minimal: true,
		skipVerify: true,
		forceSkills: true,
	};

	test("bash platforms get GNU-style flags", () => {
		expect(installerArgs(base, "ubuntu")).toEqual([
			"--minimal",
			"--skip-verify",
			"--force-skills",
		]);
	});

	test("windows gets PowerShell switches", () => {
		expect(installerArgs(base, "windows")).toEqual([
			"-Minimal",
			"-SkipVerify",
			"-ForceSkills",
		]);
	});

	test("no flags when none requested", () => {
		expect(installerArgs(NO_FLAGS, "windows")).toEqual([]);
	});
});

describe("uninstallerArgs", () => {
	const base = {
		...NO_FLAGS,
		uninstall: true,
		yes: true,
		skillsOnly: true,
		purgeDownloads: true,
	};

	test("bash platforms get GNU-style flags", () => {
		expect(uninstallerArgs(base, "ubuntu")).toEqual([
			"--yes",
			"--skills-only",
			"--purge-downloads",
		]);
	});

	test("windows gets PowerShell switches", () => {
		expect(uninstallerArgs(base, "windows")).toEqual([
			"-Yes",
			"-SkillsOnly",
			"-PurgeDownloads",
		]);
	});
});
