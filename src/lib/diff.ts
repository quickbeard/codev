// Shared diff helpers used by every provider's tool-use renderer. Providers
// previously had their own copies — the codex/opencode ones were naive (every
// old line as `-`, every new line as `+`), so the same edit rendered very
// differently across providers. Keep the LCS version here as the single
// source of truth.

export function textValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function buildLineDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const dp = Array.from({ length: oldLines.length + 1 }, () =>
		Array<number>(newLines.length + 1).fill(0),
	);
	const cell = (row: number, column: number) => dp[row]?.[column] ?? 0;

	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			const row = dp[i];
			if (!row) continue;
			row[j] =
				oldLines[i] === newLines[j]
					? cell(i + 1, j + 1) + 1
					: Math.max(cell(i + 1, j), cell(i, j + 1));
		}
	}

	const lines: string[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			lines.push(` ${oldLines[i]}`);
			i++;
			j++;
		} else if (cell(i + 1, j) >= cell(i, j + 1)) {
			lines.push(`-${oldLines[i]}`);
			i++;
		} else {
			lines.push(`+${newLines[j]}`);
			j++;
		}
	}
	while (i < oldLines.length) {
		lines.push(`-${oldLines[i]}`);
		i++;
	}
	while (j < newLines.length) {
		lines.push(`+${newLines[j]}`);
		j++;
	}
	return lines.join("\n");
}

// Accepts both snake_case (Claude Code, Codex `replace_file_content`) and
// camelCase (OpenCode `edit`) input shapes — providers used to diverge on this.
export function diffFromEditInput(input: Record<string, unknown>): string {
	const oldText = textValue(input.old_string) || textValue(input.oldString);
	const newText = textValue(input.new_string) || textValue(input.newString);
	if (!oldText && !newText) return "";
	return buildLineDiff(oldText, newText);
}

// File-creation/overwrite tools (`write`/`write_file`/`save_file`, OpenCode
// `write`) supply whole-file `content` with no old/new pair, so they have no
// natural diff. Render every line as an addition so the LOC enricher — which
// only counts `+`/`-` lines inside ```diff fences — attributes the full file
// to proposed (and accepted/rejected) lines. Without this, writes render as a
// plain code fence and count as zero LOC, unlike edits.
export function diffFromWriteContent(content: string): string {
	if (!content) return "";
	return content
		.split("\n")
		.map((line) => `+${line}`)
		.join("\n");
}
