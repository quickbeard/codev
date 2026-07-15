// Remove C0/C1 control characters (including ESC, which neutralises ANSI escape
// sequences) from a string before it's printed to a terminal. Fields that
// originate from the hub — skill name, description, provider, id — are
// attacker-influenced, so rendering them raw would allow terminal escape
// injection (cursor/clipboard manipulation, layout corruption). Printable text
// is left untouched.
export function stripControlChars(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		// Drop C0 (0x00–0x1F), DEL (0x7F), and C1 (0x80–0x9F) control ranges.
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
		out += ch;
	}
	return out;
}
