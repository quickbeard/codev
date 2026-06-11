import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	agentLogsDir,
	buildFilename,
	cliLogsDir,
	formatUtcTimestamp,
	generateSlug,
	projectFolderName,
	projectLogsDir,
} from "@/lib/paths.js";

let tempHome: string;
beforeEach(() => {
	// Canonicalize so realpathSync calls inside the module match the tempHome
	// we hand to homedir() — on macOS /var → /private/var.
	tempHome = realpathSync(mkdtempSync(join(tmpdir(), "codev-paths-")));
	vi.stubEnv("HOME", tempHome);
	// homedir() reads USERPROFILE on Windows, HOME on POSIX. Stub both so tests
	// hit the temp home on every platform.
	vi.stubEnv("USERPROFILE", tempHome);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("agentLogsDir", () => {
	test("returns ~/.codev/agent-logs", () => {
		expect(agentLogsDir()).toBe(join(tempHome, ".codev", "agent-logs"));
	});
});

describe("cliLogsDir", () => {
	test("returns ~/.codev/logs", () => {
		expect(cliLogsDir()).toBe(join(tempHome, ".codev", "logs"));
	});
});

describe("projectFolderName", () => {
	test("strips home prefix and dashes the remainder", () => {
		const cwd = join(tempHome, "works", "repos", "codev");
		mkdirSync(cwd, { recursive: true });
		expect(projectFolderName(cwd)).toBe("works-repos-codev");
	});

	test("returns 'home' when cwd is the home dir itself", () => {
		expect(projectFolderName(tempHome)).toBe("home");
	});

	test("falls back to dashed full path for cwd outside home", () => {
		const tempOther = realpathSync(
			mkdtempSync(join(tmpdir(), "codev-outside-")),
		);
		try {
			expect(projectFolderName(tempOther)).not.toBe("home");
		} finally {
			rmSync(tempOther, { recursive: true, force: true });
		}
	});

	test("collapses runs of dashes from special characters", () => {
		const cwd = join(tempHome, "My Project (v2)", "app");
		mkdirSync(cwd, { recursive: true });
		expect(projectFolderName(cwd)).toBe("My-Project-v2-app");
	});

	test("resolves symlinks before mangling", () => {
		const real = join(tempHome, "real-project");
		const linkPath = join(tempHome, "link-project");
		mkdirSync(real, { recursive: true });
		symlinkSync(real, linkPath);
		expect(projectFolderName(linkPath)).toBe("real-project");
	});
});

describe("projectLogsDir", () => {
	test("joins the agent-logs root with the per-project folder name", () => {
		const cwd = join(tempHome, "works", "codev");
		mkdirSync(cwd, { recursive: true });
		expect(projectLogsDir(cwd)).toBe(
			join(tempHome, ".codev", "agent-logs", "works-codev"),
		);
	});
});

describe("formatUtcTimestamp", () => {
	test("emits YYYY-MM-DD_HH-MM-SSZ in UTC", () => {
		const date = new Date(Date.UTC(2026, 3, 27, 18, 32, 5));
		expect(formatUtcTimestamp(date)).toBe("2026-04-27_18-32-05Z");
	});
});

describe("generateSlug", () => {
	test("takes the first 4 words, lowercased and hyphenated", () => {
		expect(generateSlug("Help me fix the login bug in auth.ts")).toBe(
			"help-me-fix-the",
		);
	});

	test("returns empty string for empty message", () => {
		expect(generateSlug("")).toBe("");
	});

	test("returns empty string for punctuation-only message", () => {
		expect(generateSlug("...!!!???")).toBe("");
	});

	test("expands @ into 'at'", () => {
		expect(generateSlug("Fix bug in @app/users.ts")).toBe("fix-bug-in-at");
	});

	test("strips Unicode accents", () => {
		expect(generateSlug("Refactor café module please")).toBe(
			"refactor-cafe-module-please",
		);
	});
});

describe("buildFilename", () => {
	test("appends slug after timestamp when first user message exists", () => {
		const session = {
			id: "abc",
			agent: "claude-code" as const,
			createdAt: new Date(Date.UTC(2026, 3, 27, 18, 32, 5)),
			firstUserMessage: "Help me fix the login bug",
			messages: [],
		};
		expect(buildFilename(session)).toBe(
			"2026-04-27_18-32-05Z-help-me-fix-the.md",
		);
	});

	test("uses bare timestamp when no first user message", () => {
		const session = {
			id: "abc",
			agent: "codex" as const,
			createdAt: new Date(Date.UTC(2026, 3, 27, 19, 15, 22)),
			messages: [],
		};
		expect(buildFilename(session)).toBe("2026-04-27_19-15-22Z.md");
	});
});
