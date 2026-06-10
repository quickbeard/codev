// Best-effort clipboard write via the OSC 52 terminal escape sequence. Widely
// supported (iTerm2, kitty, recent xterm, Windows Terminal, tmux with
// `set-clipboard on`); terminals that don't understand it silently drop the
// sequence, so the call is always safe — the visible URL stays as a manual
// fallback. We only ever *set* the clipboard (the `c` selection), never read
// it, so there's no surprise capture of the user's existing clipboard.
//
// Wrapped in an object (mirroring `browserOpener` in auth.ts) so tests can spy
// on the write without intercepting process.stdout.
export const clipboard = {
	copy(text: string): void {
		const payload = Buffer.from(text, "utf-8").toString("base64");
		// OSC (ESC ]) 52 ; c (clipboard target) ; <base64> ; BEL terminator.
		process.stdout.write(`\x1b]52;c;${payload}\x07`);
	},
};
