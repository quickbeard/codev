// Whether this process can read the keyboard, and how to say so usefully.
//
// Ink drives every CoDev prompt through raw mode, and its definition of
// "supported" is one property — `isRawModeSupported = stdin.isTTY`
// (ink/build/components/App.js). When a component calls `useInput` and that is
// falsy, Ink throws from a mount effect:
//
//     Raw mode is not supported on the current process.stdin, which Ink uses
//     as input stream by default.
//
// which reaches the user as a React stack across a 2.4 MB bundle. The common
// way to land there on Windows is Git Bash: MSYS2/mintty pipes stdin through
// its own pty emulation rather than a Win32 console, so Node sees a pipe, sets
// no `isTTY`, and raw mode is unavailable even though a human is plainly typing
// at a keyboard. This module detects that up front so the dispatcher can refuse
// with a sentence and a fix instead, and so `codevhub doctor` can report it as
// a check like any other.

// Stubbable indirection, same idiom as tlsApi / httpApi / spawner: `isTTY` is a
// plain property on the stream, so tests cannot spy on it directly.
export const stdinApi = {
	isTty(): boolean {
		return Boolean(process.stdin.isTTY);
	},
};

/**
 * Mirrors Ink's own gate exactly (`isRawModeSupported = stdin.isTTY`). Kept as
 * one function so the two can never drift: anything that decides whether a
 * prompt can be mounted must ask this, not re-derive it.
 */
export function rawModeSupported(): boolean {
	return stdinApi.isTty();
}

export type StdinKind = "tty" | "msys" | "ci" | "redirected";

type Env = Partial<Record<string, string>>;

function nonEmpty(value: string | undefined): string | undefined {
	return value && value.trim() !== "" ? value : undefined;
}

/**
 * A Git Bash / MSYS2 / Cygwin shell on Windows.
 *
 * `MSYSTEM` (MINGW64 / MINGW32 / MSYS) is the reliable signal — the Git for
 * Windows launcher exports it, unlike bash's `OSTYPE`, which is an internal
 * variable and never reaches us. `TERM_PROGRAM=mintty` covers Cygwin and older
 * Git builds, and `SHELL` pointing at bash is a last resort: native cmd.exe and
 * PowerShell set none of the three, so a false positive here is unlikely and
 * costs only a slightly wrong sentence.
 */
function looksLikeMsys(env: Env): boolean {
	if (process.platform !== "win32") return false;
	if (nonEmpty(env.MSYSTEM)) return true;
	if (nonEmpty(env.TERM_PROGRAM)?.toLowerCase() === "mintty") return true;
	return (nonEmpty(env.SHELL) ?? "").includes("bash");
}

function looksLikeCi(env: Env): boolean {
	const ci = nonEmpty(env.CI);
	if (ci && ci !== "false" && ci !== "0") return true;
	return Boolean(
		nonEmpty(env.GITHUB_ACTIONS) ??
			nonEmpty(env.GITLAB_CI) ??
			nonEmpty(env.JENKINS_URL) ??
			nonEmpty(env.TF_BUILD),
	);
}

/**
 * Why the keyboard is unavailable, or "tty" when it isn't a problem.
 *
 * CI is tested before MSYS deliberately: a Windows CI runner using Git Bash is
 * non-interactive by design, and telling it to open Windows Terminal would be
 * nonsense advice.
 */
export function stdinKind(env: Env = process.env): StdinKind {
	if (rawModeSupported()) return "tty";
	if (looksLikeCi(env)) return "ci";
	if (looksLikeMsys(env)) return "msys";
	return "redirected";
}

/**
 * The identifying facts, verbatim, for the doctor row and the report. Same
 * reasoning as `proxyEnvSummary`: on a misbehaving machine the variable nobody
 * thought to look at is usually the culprit, so we print what we actually saw
 * rather than only our conclusion from it.
 */
export function terminalEvidence(env: Env = process.env): string[] {
	const facts: string[] = [`stdin.isTTY=${String(process.stdin.isTTY)}`];
	for (const name of [
		"MSYSTEM",
		"TERM_PROGRAM",
		"TERM",
		"SHELL",
		"CI",
	] as const) {
		const value = nonEmpty(env[name]);
		if (value) facts.push(`${name}=${value}`);
	}
	facts.push(`platform=${process.platform}`);
	return facts;
}

/** One line for a check row: the verdict, then the shell we think we are in. */
export function describeStdin(env: Env = process.env): string {
	const kind = stdinKind(env);
	// A working terminal gets the short form. The full evidence exists to explain
	// a *failure*; printing seven facts to say "this is fine" only buries the
	// rows that need reading — the opposite of proxyEnvCheck, where a missing
	// variable is itself the diagnosis and so every one is always listed.
	if (kind === "tty") {
		const term =
			nonEmpty(env.TERM_PROGRAM) ??
			nonEmpty(env.TERM) ??
			`platform=${process.platform}`;
		return `interactive TTY · ${term}`;
	}
	const label =
		kind === "msys"
			? "Git Bash / MSYS2 shell — stdin is an MSYS pipe, not a Windows console"
			: kind === "ci"
				? "CI or non-interactive environment"
				: "input is redirected or piped";
	return `not a TTY · ${label} · ${terminalEvidence(env).join(" · ")}`;
}

/** Plain-language cause, for a Diagnosis. */
export function terminalCause(env: Env = process.env): string {
	switch (stdinKind(env)) {
		case "msys":
			return "Git Bash (MSYS2/mintty) pipes stdin through its own pty emulation instead of a Windows console, so Node reports process.stdin as a pipe. Raw mode — which every keyboard prompt needs — is unavailable there, however interactive the terminal looks.";
		case "ci":
			return "This looks like a CI or otherwise non-interactive environment, where no keyboard is attached to stdin.";
		case "redirected":
			return "stdin is not a terminal — it is being redirected or piped from somewhere else (a file, another process, or `< /dev/null`).";
		case "tty":
			return "stdin is an interactive terminal; raw mode is available.";
	}
}

/**
 * What to do about it. `command` is the bare command word (`install`), never the
 * full argv — `codevhub login --password …` must not be echoed back.
 */
export function terminalFix(command: string, env: Env = process.env): string {
	switch (stdinKind(env)) {
		case "msys":
			// `//c` rather than `/c`: MSYS rewrites a leading single slash into a
			// Windows path before cmd.exe ever sees it. winpty ships with Git for
			// Windows, so this needs no extra install.
			return `Run it from Windows Terminal, PowerShell, or cmd.exe. To stay in Git Bash, allocate a real console: winpty cmd //c codevhub ${command}`;
		case "ci":
			return `\`codevhub ${command}\` needs a keyboard. For unattended use, \`codevhub login --username <u> --password <p>\` signs in non-interactively, and \`codevhub update\` / \`codevhub remove --yes\` need no input.`;
		case "redirected":
			return `Run \`codevhub ${command}\` directly in a terminal, without redirecting or piping its input.`;
		case "tty":
			return "";
	}
}

/**
 * The dispatcher's gate: the message to print before exiting, or null when the
 * command can run. Structured like `diagnoseError`'s output — what happened,
 * why on this machine, then the fix — because that is what the user needs and
 * a React mount stack is not.
 *
 * Also points at `codevhub doctor`, which deliberately stays runnable without a
 * keyboard (it degrades to skipping the prompts) and is the one thing that can
 * still tell this user something useful about their machine.
 */
export function interactiveTerminalBlocker(
	command: string,
	env: Env = process.env,
): string | null {
	if (rawModeSupported()) return null;
	return [
		`\`codevhub ${command}\` needs to read the keyboard, but this terminal cannot provide it.`,
		"",
		terminalCause(env),
		"",
		`Fix: ${terminalFix(command, env)}`,
		"",
		"`codevhub doctor` still works here and will check the rest of this machine.",
	].join("\n");
}
