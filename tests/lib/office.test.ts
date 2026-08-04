import { describe, expect, test } from "vitest";
import {
	detectPlatform,
	formatSize,
	officeBundleName,
	officeScriptName,
	parseOfficeArgs,
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
			forceSkills: false,
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
			"--force-skills",
		]);
		expect(parsed).toEqual({
			platform: "windows",
			dir: "/tmp/x",
			downloadOnly: true,
			minimal: true,
			skipVerify: true,
			forceSkills: true,
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

// The names are a contract with the codev-scripts repo (codev-office/*) and
// the codev-storage bucket layout — a drift here is a broken download for
// every user, so the full set is spelled out.
describe("office file names", () => {
	test("bundle names", () => {
		expect(officeBundleName("ubuntu")).toBe("codev-office-ubuntu.zip");
		expect(officeBundleName("macos")).toBe("codev-office-macos.zip");
		expect(officeBundleName("windows")).toBe("codev-office-windows.zip");
	});

	test("script names", () => {
		expect(officeScriptName("ubuntu")).toBe("codev-office-ubuntu-setup.sh");
		expect(officeScriptName("macos")).toBe("codev-office-macos-setup.sh");
		expect(officeScriptName("windows")).toBe("codev-office-windows-setup.ps1");
	});
});

describe("formatSize", () => {
	test("KB below 1 MB — a 13 KB script must not render as 0.0 MB", () => {
		expect(formatSize(13 * 1024)).toBe("13.0 KB");
		expect(formatSize(0)).toBe("0.0 KB");
	});

	test("MB from 1 MB up", () => {
		expect(formatSize(1024 * 1024)).toBe("1.0 MB");
		expect(formatSize(637_252_608)).toBe("607.7 MB");
	});
});
