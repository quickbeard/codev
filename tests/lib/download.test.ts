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
	migrateLegacyOfficeDir,
	officeWrapperBakedArgs,
	officeWrapperContent,
	officeWrapperName,
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
// Simulate a middlebox that honors Range but ignores If-Range semantics —
// answering 206 (with the current entity's ETag) even when If-Range mismatches.
let brokenIfRange = false;
// Extra objects (path -> body) the server should serve.
let objects: Map<string, Buffer>;

beforeEach(async () => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-download-"));
	rangeLog = [];
	ignoreRange = false;
	omitContentLength = false;
	brokenIfRange = false;
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
		if (
			range &&
			!ignoreRange &&
			(brokenIfRange || ifRange === undefined || ifRange === etag)
		) {
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

	test("refuses a bare-Range resume of an ETag-less partial without a sha256", async () => {
		const dest = join(tempDir, "payload.bin");
		// A partial with no `.etag` on record (pre-ETag download, or a cleared
		// record). Without an expected sha256 nothing downstream would catch a
		// splice, so the partial must be scrapped, not resumed.
		writeFileSync(`${dest}.partial`, Buffer.from("stale-old-bytes"));
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		// No Range header ever reached the server — a clean full download.
		expect(rangeLog).toEqual([undefined]);
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
		expect(existsSync(`${dest}.partial`)).toBe(false);
	});

	test("scraps the partial when a broken hop answers 206 across a republish", async () => {
		// A middlebox that honors Range while ignoring If-Range: it answers 206
		// for a republished entity, which used to splice the halves together
		// ("bad zipfile offset" on real bundle downloads).
		brokenIfRange = true;
		const dest = join(tempDir, "payload.bin");
		writeFileSync(`${dest}.partial`, Buffer.from("stale-old-bytes"));
		writeFileSync(`${dest}.etag`, '"stale-etag"');
		await downloadFile({ url: `${baseUrl}/payload.bin`, dest, endpoint: "t" });
		// The lying 206 carried the new object's ETag → partial scrapped, then
		// a clean full refetch (no Range on the second request).
		expect(rangeLog).toEqual(["bytes=15-", undefined]);
		expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
		expect(existsSync(`${dest}.partial`)).toBe(false);
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
			["--dir", dir, "--skip-verify"],
			baseUrl,
			async (command, args, cwd) => {
				spawned = { command, args, cwd };
				return 0;
			},
		);
		expect(code).toBe(0);
		expect(spawned).toEqual({
			command: "bash",
			args: [join(dir, scriptName), "--skip-verify"],
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

	test("windows staging writes the right-click wrapper, flags baked in, never spawns", async () => {
		// Endpoint protection (KES) silently kills installers spawned by
		// codevhub on Windows, so the windows flow must never spawn - it
		// stages a .cmd the user runs via right-click -> Run as administrator.
		objects.set("/codev-office-windows.zip", BUNDLE);
		objects.set("/codev-office-windows-setup.ps1", SCRIPT);
		const dir = join(tempDir, "office");
		const spawns: string[] = [];
		const code = await runSkillOffice(
			[
				"--platform",
				"windows",
				"--dir",
				dir,
				"--skip-verify",
				"--force-skills",
			],
			baseUrl,
			async (command) => {
				spawns.push(command);
				return 0;
			},
		);
		expect(code).toBe(0);
		expect(spawns).toEqual([]);
		const wrapper = readFileSync(join(dir, "Install-CoDev-Office.cmd"), "utf8");
		expect(wrapper).toContain(
			'powershell -ExecutionPolicy Bypass -File ".\\codev-office-windows-setup.ps1" -SkipVerify -ForceSkills',
		);
		expect(wrapper).toContain("pause");
		expect(wrapper).toContain('cd /d "%~dp0"');
		// Self-elevation: a plain double-click must request admin rights itself
		// (some environments strip "Run as administrator" from the context
		// menu) and fall back to a non-elevated run when declined.
		expect(wrapper).toContain("net session");
		expect(wrapper).toContain("Start-Process -FilePath '%~f0' -Verb RunAs");
		expect(wrapper).toContain(":run");
		expect(wrapper).toContain("Continuing without administrator rights");
		// Profile-safe path baking: the shared modules dir always, but no
		// -SkillsRoot on cross-platform staging - this host's homedir says
		// nothing about the target machine's user.
		expect(wrapper).toContain(
			"-ModulesDir C:\\Users\\Public\\codev-office\\node_modules",
		);
		expect(wrapper).not.toContain("-SkillsRoot");
	});

	test("baked args pin the real user's skills root on a Windows host", () => {
		expect(officeWrapperBakedArgs(false)).toEqual([
			"-ModulesDir",
			"C:\\Users\\Public\\codev-office\\node_modules",
		]);
		const onWindows = officeWrapperBakedArgs(true);
		expect(onWindows.slice(0, 2)).toEqual([
			"-ModulesDir",
			"C:\\Users\\Public\\codev-office\\node_modules",
		]);
		expect(onWindows[2]).toBe("-SkillsRoot");
		expect(onWindows[3]).toContain(".config");
	});

	test("wrapper quotes arguments containing spaces", () => {
		const content = officeWrapperContent("s.ps1", [
			"-SkillsRoot",
			"C:\\Users\\Van Phong\\.config\\codev\\skills",
		]);
		expect(content).toContain(
			'-SkillsRoot "C:\\Users\\Van Phong\\.config\\codev\\skills"',
		);
	});

	test("migrateLegacyOfficeDir moves files without clobbering", () => {
		const from = join(tempDir, "legacy-office");
		const to = join(tempDir, "public-office");
		mkdirSync(from, { recursive: true });
		mkdirSync(to, { recursive: true });
		writeFileSync(join(from, "bundle.zip"), "old-bundle");
		writeFileSync(join(from, "kept.txt"), "from-legacy");
		writeFileSync(join(to, "kept.txt"), "already-new");
		migrateLegacyOfficeDir(from, to);
		// Moved when absent at the destination, left alone when present.
		expect(readFileSync(join(to, "bundle.zip"), "utf8")).toBe("old-bundle");
		expect(readFileSync(join(to, "kept.txt"), "utf8")).toBe("already-new");
		expect(existsSync(join(from, "bundle.zip"))).toBe(false);
		// A missing source dir is a no-op, not an error.
		migrateLegacyOfficeDir(join(tempDir, "nope"), to);
	});

	test("wrapper name and content cover the uninstall flow", () => {
		expect(officeWrapperName(false)).toBe("Install-CoDev-Office.cmd");
		expect(officeWrapperName(true)).toBe("Uninstall-CoDev-Office.cmd");
		const content = officeWrapperContent("codev-office-windows-uninstall.ps1", [
			"-Yes",
			"-SkillsOnly",
		]);
		expect(content).toContain(
			'powershell -ExecutionPolicy Bypass -File ".\\codev-office-windows-uninstall.ps1" -Yes -SkillsOnly',
		);
		// CRLF line endings - the file must open cleanly in cmd.exe.
		expect(content).toContain("\r\n");
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
	test("a Windows host stages the right-click wrapper instead of spawning", async () => {
		// Endpoint protection (KES in the field) silently kills a powershell
		// child of node.exe mid-install, so the installer must never be
		// spawned from codevhub on Windows — the user launches the staged
		// .cmd via right-click -> Run as administrator instead.
		objects.set("/codev-office-windows.zip", BUNDLE);
		objects.set("/codev-office-windows-setup.ps1", SCRIPT);
		const dir = join(tempDir, "office");
		let spawned: { command: string; args: string[]; cwd: string } | null = null;
		const code = await withPlatform("win32", () =>
			runSkillOffice(
				["--dir", dir, "--skip-verify"],
				baseUrl,
				async (command, args, cwd) => {
					spawned = { command, args, cwd };
					return 0;
				},
			),
		);
		expect(code).toBe(0);
		expect(spawned).toBeNull();
		const wrapper = readFileSync(join(dir, "Install-CoDev-Office.cmd"), "utf8");
		expect(wrapper).toContain(
			'powershell -ExecutionPolicy Bypass -File ".\\codev-office-windows-setup.ps1" -SkipVerify',
		);
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
		skipVerify: true,
		forceSkills: true,
	};

	test("bash platforms get GNU-style flags", () => {
		expect(installerArgs(base, "ubuntu")).toEqual([
			"--skip-verify",
			"--force-skills",
		]);
	});

	test("windows gets PowerShell switches", () => {
		expect(installerArgs(base, "windows")).toEqual([
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
