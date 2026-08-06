import { describe, expect, test } from "vitest";
import {
	detectArch,
	detectPlatform,
	formatSize,
	officeBundleName,
	officeScriptName,
	officeTarget,
	officeUninstallScriptName,
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

describe("detectArch", () => {
	test("maps node arches to the uname -m names the bundles use", () => {
		expect(detectArch("arm64", false)).toBe("arm64");
		expect(detectArch("x64", false)).toBe("x86_64");
	});

	test("returns null for arches no bundle is built for", () => {
		expect(detectArch("ia32", false)).toBeNull();
		expect(detectArch("ppc64", false)).toBeNull();
	});

	// An x64 node under Rosetta reports "x64" on an Apple Silicon Mac. Believing
	// it downloads the Intel bundle, which the native-bash setup script then
	// refuses — and re-downloads the arm64 one. 3.2 GB to land 1.6.
	test("Rosetta translation overrides the reported x64", () => {
		expect(detectArch("x64", true)).toBe("arm64");
	});
});

describe("officeTarget", () => {
	test("non-macOS platforms ignore the arch", () => {
		expect(officeTarget("ubuntu", null)).toBe("ubuntu");
		expect(officeTarget("windows", null)).toBe("windows");
		expect(officeTarget("ubuntu", "arm64")).toBe("ubuntu");
	});

	test("macOS resolves to a per-chip target", () => {
		expect(officeTarget("macos", "arm64")).toBe("macos-arm64");
		expect(officeTarget("macos", "x86_64")).toBe("macos-x86_64");
	});

	test("macOS without an arch has no target — never guess a 1.6 GB download", () => {
		expect(officeTarget("macos", null)).toBeNull();
	});
});

describe("parseOfficeArgs", () => {
	test("defaults", () => {
		expect(parseOfficeArgs([])).toEqual({
			downloadOnly: false,
			skipVerify: false,
			forceSkills: false,
			uninstall: false,
			yes: false,
			skillsOnly: false,
			purgeDownloads: false,
		});
	});

	test("all flags, space-separated values", () => {
		const parsed = parseOfficeArgs([
			"--platform",
			"windows",
			"--dir",
			"/tmp/x",
			"--download-only",
			"--skip-verify",
			"--force-skills",
		]);
		expect(parsed).toEqual({
			platform: "windows",
			dir: "/tmp/x",
			downloadOnly: true,
			skipVerify: true,
			forceSkills: true,
			uninstall: false,
			yes: false,
			skillsOnly: false,
			purgeDownloads: false,
		});
	});

	test("uninstall mode with its passthrough flags (unadvertised)", () => {
		const parsed = parseOfficeArgs([
			"--uninstall",
			"--yes",
			"--skills-only",
			"--purge-downloads",
		]);
		expect(parsed.error).toBeUndefined();
		expect(parsed.uninstall).toBe(true);
		expect(parsed.yes).toBe(true);
		expect(parsed.skillsOnly).toBe(true);
		expect(parsed.purgeDownloads).toBe(true);
	});

	test("rejects install flags combined with --uninstall", () => {
		expect(parseOfficeArgs(["--uninstall", "--skip-verify"]).error).toMatch(
			/do not apply with --uninstall/,
		);
	});

	test("rejects uninstall passthroughs without --uninstall", () => {
		expect(parseOfficeArgs(["--yes"]).error).toMatch(/require --uninstall/);
	});

	test("--platform=value form", () => {
		expect(parseOfficeArgs(["--platform=macos"]).platform).toBe("macos");
	});

	test("rejects an unknown platform", () => {
		expect(parseOfficeArgs(["--platform", "solaris"]).error).toMatch(
			/--platform must be one of/,
		);
	});

	test("--arch, both spellings and the aliases people actually type", () => {
		expect(parseOfficeArgs(["--arch", "arm64"]).arch).toBe("arm64");
		expect(parseOfficeArgs(["--arch=x86_64"]).arch).toBe("x86_64");
		expect(parseOfficeArgs(["--arch", "aarch64"]).arch).toBe("arm64");
		expect(parseOfficeArgs(["--arch", "x64"]).arch).toBe("x86_64");
		expect(parseOfficeArgs(["--arch", "Intel"]).arch).toBe("x86_64");
	});

	test("rejects an unknown or missing arch", () => {
		expect(parseOfficeArgs(["--arch", "ppc64"]).error).toMatch(
			/--arch must be one of/,
		);
		expect(parseOfficeArgs(["--arch"]).error).toMatch(/--arch must be one of/);
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
	test("bundle names — four bundles, macOS split per chip", () => {
		expect(officeBundleName("ubuntu")).toBe("codev-office-ubuntu.zip");
		expect(officeBundleName("windows")).toBe("codev-office-windows.zip");
		expect(officeBundleName("macos-arm64")).toBe(
			"codev-office-macos-arm64.zip",
		);
		expect(officeBundleName("macos-x86_64")).toBe(
			"codev-office-macos-x86_64.zip",
		);
	});

	// Three scripts, not four: the single macOS script resolves its own bundle
	// from `uname -m`, so splitting the bundles added no script to pick between.
	test("script names", () => {
		expect(officeScriptName("ubuntu")).toBe("codev-office-ubuntu-setup.sh");
		expect(officeScriptName("macos")).toBe("codev-office-macos-setup.sh");
		expect(officeScriptName("windows")).toBe("codev-office-windows-setup.ps1");
	});

	test("uninstall script names", () => {
		expect(officeUninstallScriptName("ubuntu")).toBe(
			"codev-office-ubuntu-uninstall.sh",
		);
		expect(officeUninstallScriptName("macos")).toBe(
			"codev-office-macos-uninstall.sh",
		);
		expect(officeUninstallScriptName("windows")).toBe(
			"codev-office-windows-uninstall.ps1",
		);
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
