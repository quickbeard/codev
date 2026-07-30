// Best-effort, synchronous detection of whether the terminal has a light
// background. The only signal available without an escape-sequence round trip
// (which would fight Ink for the TTY) is the `COLORFGBG` variable that Konsole,
// rxvt, and a handful of other terminals export. When it is absent or
// unparseable we return null ("unknown") and callers fall back to the
// terminal's own default foreground, which is readable on any background.
export function terminalIsLight(
	env: NodeJS.ProcessEnv = process.env,
): boolean | null {
	const fgbg = env.COLORFGBG;
	if (!fgbg) return null;

	// `COLORFGBG` is "fg;bg" or, on rxvt, "fg;default;bg" — the background is
	// always the last field.
	const parts = fgbg.split(";");
	const bg = Number(parts[parts.length - 1]);
	if (!Number.isInteger(bg)) return null;

	// Standard ANSI palette convention (the same one vim uses to pick
	// `background`): 0–6 and 8 are dark, everything else is light.
	return !(bg <= 6 || bg === 8);
}
