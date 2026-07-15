import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectAndStripRoot, extractZip, inspectZip } from "@/lib/archive.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-archive-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeZip(files: Record<string, string>): Buffer {
	const zip = new AdmZip();
	for (const [name, content] of Object.entries(files)) {
		zip.addFile(name, Buffer.from(content));
	}
	return zip.toBuffer();
}

function entryNames(buffer: Buffer): string[] {
	return new AdmZip(buffer)
		.getEntries()
		.map((e) => e.entryName)
		.sort();
}

describe("extractZip", () => {
	test("writes nested files under the target dir", async () => {
		const zip = makeZip({
			"SKILL.md": "# hi",
			"scripts/run.sh": "echo hi",
		});
		await extractZip(zip, tempDir);
		expect(readFileSync(join(tempDir, "SKILL.md"), "utf-8")).toBe("# hi");
		expect(readFileSync(join(tempDir, "scripts", "run.sh"), "utf-8")).toBe(
			"echo hi",
		);
	});

	test("rejects a zip-slip entry that escapes the target dir", async () => {
		// AdmZip sanitizes `../` on addFile, so craft the malicious name by
		// overriding entryName directly before serializing.
		const zip = new AdmZip();
		zip.addFile("evil.txt", Buffer.from("pwned"));
		const entry = zip.getEntries()[0];
		if (!entry) throw new Error("fixture setup failed");
		entry.entryName = "../evil.txt";
		const buf = zip.toBuffer();

		await expect(extractZip(buf, tempDir)).rejects.toThrow(/unsafe zip entry/);
		expect(existsSync(join(tempDir, "..", "evil.txt"))).toBe(false);
	});

	test("rejects an archive that decompresses past the size cap", async () => {
		// 101 MB of zeros compresses tiny but inflates past the 100 MB cap.
		const zip = new AdmZip();
		zip.addFile("big.bin", Buffer.alloc(101 * 1024 * 1024));
		await expect(extractZip(zip.toBuffer(), tempDir)).rejects.toThrow(/limit/i);
		// Nothing was written before the cap tripped.
		expect(existsSync(join(tempDir, "big.bin"))).toBe(false);
	});
});

describe("inspectZip", () => {
	test("accepts a normal archive and reports its files/total", () => {
		const buf = makeZip({ "SKILL.md": "hello", "run.sh": "echo hi" });
		const { files, totalBytes } = inspectZip(buf);
		expect(files.sort()).toEqual(["SKILL.md", "run.sh"].sort());
		expect(totalBytes).toBe("hello".length + "echo hi".length);
	});

	test("rejects an archive over the uncompressed size cap", () => {
		const zip = new AdmZip();
		zip.addFile("big.bin", Buffer.alloc(101 * 1024 * 1024));
		expect(() => inspectZip(zip.toBuffer())).toThrow(/limit/i);
	});
});

describe("detectAndStripRoot", () => {
	test("strips a single shared root folder", () => {
		const zip = makeZip({
			"pg-tuner/SKILL.md": "a",
			"pg-tuner/scripts/x.sh": "b",
		});
		const { buffer, stripped } = detectAndStripRoot(zip);
		expect(stripped).toBe("pg-tuner");
		expect(entryNames(buffer)).toEqual(["SKILL.md", "scripts/x.sh"]);
	});

	test("leaves the buffer unchanged when there are multiple top-level entries", () => {
		const zip = makeZip({ "SKILL.md": "a", "other.md": "b" });
		const { buffer, stripped } = detectAndStripRoot(zip);
		expect(stripped).toBeNull();
		expect(buffer).toBe(zip);
	});

	test("does not strip when the only shared name is a lone top-level file", () => {
		const zip = makeZip({ "SKILL.md": "a" });
		const { stripped } = detectAndStripRoot(zip);
		expect(stripped).toBeNull();
	});
});
