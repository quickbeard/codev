import { describe, expect, test } from "vitest";
import {
	detectPlatform,
	type OfficeManifest,
	parseOfficeArgs,
	parseOfficeManifest,
} from "@/lib/office.js";

describe("detectPlatform", () => {
	test("maps node platforms to bundle platforms", () => {
		expect(detectPlatform("linux")).toBe("ubuntu");
		expect(detectPlatform("darwin")).toBe("macos");
		expect(detectPlatform("win32")).toBe("windows");
	});

	test("returns null for unsupported platforms", () => {
		expect(detectPlatform("aix")).toBeNull();
		expect(detectPlatform("freebsd")).toBeNull();
	});
});

describe("parseOfficeArgs", () => {
	test("defaults", () => {
		expect(parseOfficeArgs([])).toEqual({
			downloadOnly: false,
			minimal: false,
			skipVerify: false,
		});
	});

	test("all flags, space-separated values", () => {
		const parsed = parseOfficeArgs([
			"--platform",
			"windows",
			"--dir",
			"/tmp/x",
			"--download-only",
			"--minimal",
			"--skip-verify",
		]);
		expect(parsed).toEqual({
			platform: "windows",
			dir: "/tmp/x",
			downloadOnly: true,
			minimal: true,
			skipVerify: true,
		});
	});

	test("--platform=value form", () => {
		expect(parseOfficeArgs(["--platform=macos"]).platform).toBe("macos");
	});

	test("rejects an unknown platform", () => {
		expect(parseOfficeArgs(["--platform", "solaris"]).error).toMatch(
			/--platform must be one of/,
		);
	});

	test("rejects --dir without a value", () => {
		expect(parseOfficeArgs(["--dir"]).error).toMatch(/--dir requires a path/);
	});

	test("rejects unknown options", () => {
		expect(parseOfficeArgs(["--wat"]).error).toMatch(/unknown option: --wat/);
	});
});

const VALID_MANIFEST: OfficeManifest = {
	schema: 1,
	version: "2026-08-03",
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
		"minimax-docx-ubuntu.zip": { size: 123, sha256: "ab".repeat(32) },
	},
};

describe("parseOfficeManifest", () => {
	test("accepts a valid manifest", () => {
		expect(parseOfficeManifest(VALID_MANIFEST)).toEqual(VALID_MANIFEST);
	});

	test("rejects a wrong schema", () => {
		expect(() => parseOfficeManifest({ ...VALID_MANIFEST, schema: 2 })).toThrow(
			/manifest.json shape/,
		);
	});

	test("rejects a missing platform entry", () => {
		const { windows: _, ...platforms } = VALID_MANIFEST.platforms;
		expect(() => parseOfficeManifest({ ...VALID_MANIFEST, platforms })).toThrow(
			/platform windows/,
		);
	});

	test("rejects malformed file entries", () => {
		expect(() =>
			parseOfficeManifest({
				...VALID_MANIFEST,
				files: { "x.zip": { size: "big", sha256: "ab" } },
			}),
		).toThrow(/file x.zip/);
	});

	test("rejects non-objects", () => {
		expect(() => parseOfficeManifest(null)).toThrow(/not an object/);
		expect(() => parseOfficeManifest("[]")).toThrow(/manifest.json shape/);
	});
});
