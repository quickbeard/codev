import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	disableClaudeCodeLoginPrompt,
	vscodeSettingsPath,
	vscodeUserDataDir,
} from "@/lib/vscode-settings.js";

let tempDir: string;
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

// Seed the per-platform VS Code user-data dir (with its User/ subdir) so the
// "VS Code is installed" gate passes, then write `contents` to settings.json.
function seedSettings(contents: string) {
	const path = vscodeSettingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-vscode-test-"));
	vi.stubEnv("HOME", tempDir);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX.
	vi.stubEnv("USERPROFILE", tempDir);
	// Keep the win32 / linux dir derivations inside the temp home too, so the
	// test never touches the host machine's real VS Code config.
	vi.stubEnv("APPDATA", join(tempDir, "AppData", "Roaming"));
	vi.stubEnv("XDG_CONFIG_HOME", join(tempDir, ".config"));
});

afterEach(() => {
	setPlatform(originalPlatform);
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

describe("vscodeUserDataDir", () => {
	test("darwin uses ~/Library/Application Support/Code", () => {
		setPlatform("darwin");
		expect(vscodeUserDataDir()).toBe(
			join(tempDir, "Library", "Application Support", "Code"),
		);
	});

	test("win32 uses %APPDATA%\\Code", () => {
		setPlatform("win32");
		expect(vscodeUserDataDir()).toBe(
			join(tempDir, "AppData", "Roaming", "Code"),
		);
	});

	test("win32 falls back to ~/AppData/Roaming/Code when APPDATA is unset", () => {
		setPlatform("win32");
		vi.stubEnv("APPDATA", undefined);
		expect(vscodeUserDataDir()).toBe(
			join(tempDir, "AppData", "Roaming", "Code"),
		);
	});

	test("linux uses $XDG_CONFIG_HOME/Code", () => {
		setPlatform("linux");
		expect(vscodeUserDataDir()).toBe(join(tempDir, ".config", "Code"));
	});

	test("linux falls back to ~/.config/Code when XDG_CONFIG_HOME is unset", () => {
		setPlatform("linux");
		vi.stubEnv("XDG_CONFIG_HOME", undefined);
		expect(vscodeUserDataDir()).toBe(join(tempDir, ".config", "Code"));
	});

	test("settings path is <userDataDir>/User/settings.json", () => {
		setPlatform("darwin");
		expect(vscodeSettingsPath()).toBe(
			join(vscodeUserDataDir(), "User", "settings.json"),
		);
	});
});

describe("disableClaudeCodeLoginPrompt", () => {
	// Run the behavior cases on a fixed platform so the seeded paths are
	// deterministic; the per-platform derivation is covered above.
	beforeEach(() => {
		setPlatform("darwin");
	});

	test("skips when VS Code is not installed (no user-data dir)", () => {
		const result = disableClaudeCodeLoginPrompt();
		expect(result).toEqual({ status: "skipped" });
		// Nothing was created.
		expect(existsSync(vscodeSettingsPath())).toBe(false);
	});

	test("creates settings.json (and User/) when the dir exists but the file does not", () => {
		mkdirSync(vscodeUserDataDir(), { recursive: true });

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("created");
		const path = vscodeSettingsPath();
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
			"claudeCode.disableLoginPrompt": true,
		});
	});

	test("adds the key while preserving other settings, comments, and trailing commas", () => {
		const path = seedSettings(
			[
				"{",
				"\t// existing user setting",
				'\t"editor.fontSize": 14,',
				'\t"workbench.colorTheme": "Default Dark+",',
				"}",
				"",
			].join("\n"),
		);

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("added");
		const raw = readFileSync(path, "utf-8");
		// Our key landed and the others survived.
		const parsed = parse(raw);
		expect(parsed["claudeCode.disableLoginPrompt"]).toBe(true);
		expect(parsed["editor.fontSize"]).toBe(14);
		expect(parsed["workbench.colorTheme"]).toBe("Default Dark+");
		// The comment was preserved verbatim — the payoff of editing as JSONC.
		expect(raw).toContain("// existing user setting");
	});

	test("flips an existing false value to true", () => {
		const path = seedSettings(
			'{\n\t"claudeCode.disableLoginPrompt": false\n}\n',
		);

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("updated");
		expect(
			parse(readFileSync(path, "utf-8"))["claudeCode.disableLoginPrompt"],
		).toBe(true);
	});

	test("leaves the file byte-identical when the key is already true", () => {
		const contents = [
			"{",
			"\t// keep me",
			'\t"claudeCode.disableLoginPrompt": true,',
			'\t"editor.fontSize": 12',
			"}",
			"",
		].join("\n");
		const path = seedSettings(contents);

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("unchanged");
		// No rewrite at all — same bytes.
		expect(readFileSync(path, "utf-8")).toBe(contents);
	});

	test("treats an empty file as addable", () => {
		const path = seedSettings("   \n");

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("added");
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
			"claudeCode.disableLoginPrompt": true,
		});
	});

	test("refuses to touch a file whose root is not a JSON object", () => {
		const contents = "[1, 2, 3]\n";
		const path = seedSettings(contents);

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("error");
		// Left exactly as we found it.
		expect(readFileSync(path, "utf-8")).toBe(contents);
	});

	test("refuses to touch a file with a JSON syntax error", () => {
		const contents = '{\n\t"editor.fontSize": \n}\n';
		const path = seedSettings(contents);

		const result = disableClaudeCodeLoginPrompt();

		expect(result.status).toBe("error");
		expect(readFileSync(path, "utf-8")).toBe(contents);
	});
});
