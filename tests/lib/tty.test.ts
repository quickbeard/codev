import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	describeStdin,
	interactiveTerminalBlocker,
	rawModeSupported,
	stdinApi,
	stdinKind,
	terminalCause,
	terminalEvidence,
	terminalFix,
} from "@/lib/tty.js";

// Every variable the classifier reads. Cleared per test so the developer's own
// shell (or CI, which sets CI=true and would make every case "ci") can't leak
// into the assertions.
const TERM_VARS = [
	"MSYSTEM",
	"TERM_PROGRAM",
	"TERM",
	"SHELL",
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"JENKINS_URL",
	"TF_BUILD",
];

function platform(value: NodeJS.Platform) {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

const realPlatform = process.platform;

beforeEach(() => {
	for (const name of TERM_VARS) vi.stubEnv(name, "");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	platform(realPlatform);
});

function noTty() {
	vi.spyOn(stdinApi, "isTty").mockReturnValue(false);
}

describe("rawModeSupported", () => {
	test("mirrors stdin.isTTY", () => {
		vi.spyOn(stdinApi, "isTty").mockReturnValue(true);
		expect(rawModeSupported()).toBe(true);
		vi.spyOn(stdinApi, "isTty").mockReturnValue(false);
		expect(rawModeSupported()).toBe(false);
	});

	// Node leaves `isTTY` *undefined* on a pipe rather than setting it false, and
	// Ink's `useInput` skips raw mode only on `isActive === false` — a strict
	// comparison. Forwarding a raw `undefined` therefore reads as "active" and
	// throws the very error this module exists to prevent, which is why both this
	// and useCanType() coerce. Asserting `toBe(false)`, not falsiness, is the
	// whole point of the test.
	test("returns a real boolean, never undefined", () => {
		const stdin = process.stdin as unknown as { isTTY?: boolean };
		const original = stdin.isTTY;
		try {
			stdin.isTTY = undefined;
			expect(rawModeSupported()).toBe(false);
		} finally {
			stdin.isTTY = original;
		}
	});
});

describe("stdinKind", () => {
	test("a real TTY short-circuits every other signal", () => {
		vi.spyOn(stdinApi, "isTty").mockReturnValue(true);
		platform("win32");
		expect(stdinKind({ MSYSTEM: "MINGW64", CI: "true" })).toBe("tty");
	});

	test("MSYSTEM on win32 is Git Bash", () => {
		noTty();
		platform("win32");
		expect(stdinKind({ MSYSTEM: "MINGW64" })).toBe("msys");
	});

	test("mintty without MSYSTEM (Cygwin) is still msys", () => {
		noTty();
		platform("win32");
		expect(stdinKind({ TERM_PROGRAM: "mintty" })).toBe("msys");
	});

	test("a bash SHELL on win32 is the last-resort msys signal", () => {
		noTty();
		platform("win32");
		expect(stdinKind({ SHELL: "C:/Program Files/Git/usr/bin/bash.exe" })).toBe(
			"msys",
		);
	});

	// The same variables on a Unix box mean an ordinary shell, and the advice
	// ("open Windows Terminal") would be nonsense there.
	test("MSYSTEM off win32 is not msys", () => {
		noTty();
		platform("darwin");
		expect(stdinKind({ MSYSTEM: "MINGW64" })).toBe("redirected");
	});

	// A Windows CI runner using Git Bash hits both signals; CI wins, because
	// telling a pipeline to open Windows Terminal is useless advice.
	test("CI outranks Git Bash", () => {
		noTty();
		platform("win32");
		expect(stdinKind({ CI: "true", MSYSTEM: "MINGW64" })).toBe("ci");
	});

	test("CI=false is not CI", () => {
		noTty();
		platform("linux");
		expect(stdinKind({ CI: "false" })).toBe("redirected");
		expect(stdinKind({ CI: "0" })).toBe("redirected");
	});

	test("other CI providers are recognized without CI itself", () => {
		noTty();
		expect(stdinKind({ GITHUB_ACTIONS: "true" })).toBe("ci");
		expect(stdinKind({ TF_BUILD: "True" })).toBe("ci");
	});

	test("a plain pipe is 'redirected'", () => {
		noTty();
		platform("linux");
		expect(stdinKind({})).toBe("redirected");
	});
});

describe("describeStdin", () => {
	test("names Git Bash and prints the evidence verbatim", () => {
		noTty();
		platform("win32");
		const detail = describeStdin({ MSYSTEM: "MINGW64", TERM: "xterm" });
		expect(detail).toContain("not a TTY");
		expect(detail).toContain("Git Bash / MSYS2");
		// The raw facts matter as much as the conclusion — same reasoning as
		// proxyEnvSummary. A reader scanning for MSYSTEM should find it stated.
		expect(detail).toContain("MSYSTEM=MINGW64");
		expect(detail).toContain("TERM=xterm");
	});

	test("a working terminal says so", () => {
		vi.spyOn(stdinApi, "isTty").mockReturnValue(true);
		expect(describeStdin({})).toContain("interactive TTY");
	});

	test("empty variables are omitted rather than printed as blanks", () => {
		noTty();
		expect(terminalEvidence({ MSYSTEM: "", TERM: "  " })).not.toContain(
			"MSYSTEM=",
		);
	});
});

describe("terminalFix", () => {
	test("Git Bash gets both the real-console and the winpty route", () => {
		noTty();
		platform("win32");
		vi.stubEnv("MSYSTEM", "MINGW64");
		const fix = terminalFix("install");
		expect(fix).toContain("Windows Terminal");
		// `//c`, not `/c`: MSYS rewrites a lone leading slash into a Windows path.
		expect(fix).toContain("winpty cmd //c codevhub install");
	});

	test("the command name is threaded through", () => {
		noTty();
		platform("win32");
		vi.stubEnv("MSYSTEM", "MINGW64");
		expect(terminalFix("model")).toContain("codevhub model");
	});

	test("a redirected stdin is told to stop piping, not to change terminal", () => {
		noTty();
		platform("linux");
		const fix = terminalFix("config");
		expect(fix).toContain("without redirecting or piping");
		expect(fix).not.toContain("winpty");
	});

	test("CI is pointed at the non-interactive commands", () => {
		noTty();
		vi.stubEnv("CI", "true");
		const fix = terminalFix("install");
		expect(fix).toContain("--username");
		expect(fix).toContain("remove --yes");
	});
});

describe("interactiveTerminalBlocker", () => {
	test("returns null on a real terminal so no command is blocked", () => {
		vi.spyOn(stdinApi, "isTty").mockReturnValue(true);
		expect(interactiveTerminalBlocker("install")).toBeNull();
	});

	test("explains what, why, and how to fix it", () => {
		noTty();
		platform("win32");
		vi.stubEnv("MSYSTEM", "MINGW64");
		const message = interactiveTerminalBlocker("install");
		expect(message).not.toBeNull();
		expect(message).toContain("`codevhub install` needs to read the keyboard");
		expect(message).toContain("Git Bash");
		expect(message).toContain("Fix:");
		// doctor degrades instead of crashing, so it is the one thing left to
		// recommend here. Pinning it keeps the two decisions in step.
		expect(message).toContain("`codevhub doctor` still works here");
	});

	test("the cause is plain language, not an errno", () => {
		noTty();
		platform("win32");
		vi.stubEnv("MSYSTEM", "MINGW64");
		expect(terminalCause()).toContain("pty emulation");
	});
});
