import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";

// The Claude Code VS Code extension reads codev's gateway credentials from
// the shared ~/.claude/settings.json the CLI also uses. With those in place
// the extension's interactive login prompt is redundant and confusing, so we
// flip its `claudeCode.disableLoginPrompt` setting on. This lives apart from
// vscode.ts (whose job is installing extensions via the `code` CLI) because
// its job is editing VS Code's own settings.json on disk.
const SETTING_KEY = "claudeCode.disableLoginPrompt";

// settings.json is JSONC (comments + trailing commas), so we edit it with
// jsonc-parser's modify/applyEdits, which touch only the one key and leave
// every other setting, comment, and the file's formatting intact. 2-space
// indent matches the rest of codev's JSON output.
const FORMATTING = { insertSpaces: true, tabSize: 2 } as const;
const PARSE_OPTIONS = {
	allowTrailingComma: true,
	allowEmptyContent: true,
} as const;

// The contents written when there's no usable JSON to edit (missing or
// empty/whitespace-only file). 2-space indent, trailing newline.
const FRESH_CONTENTS = `${JSON.stringify({ [SETTING_KEY]: true }, null, 2)}\n`;

// Per-platform VS Code "user data" directory (the dir that holds `User/`).
// Honors the standard env overrides, falling back to the conventional path:
//   darwin: ~/Library/Application Support/Code
//   win32:  %APPDATA%\Code            (≈ C:\Users\<user>\AppData\Roaming\Code)
//   linux:  $XDG_CONFIG_HOME/Code     (≈ ~/.config/Code)
export function vscodeUserDataDir(): string {
	const home = homedir();
	if (process.platform === "darwin") {
		return join(home, "Library", "Application Support", "Code");
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		return join(appData, "Code");
	}
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
	return join(xdgConfig, "Code");
}

export function vscodeSettingsPath(): string {
	return join(vscodeUserDataDir(), "User", "settings.json");
}

export type VscodeLoginPromptResult =
	// VS Code isn't installed (no user-data dir) — nothing to do.
	| { status: "skipped" }
	// The one key was created / inserted / flipped, or already correct.
	| { status: "created" | "added" | "updated" | "unchanged"; path: string }
	// settings.json exists but couldn't be parsed/edited safely; left untouched.
	| { status: "error"; warning: string };

// Idempotently set `claudeCode.disableLoginPrompt: true` in VS Code's
// settings.json. Gated on VS Code being installed; a malformed or non-object
// settings.json is left untouched (we never risk clobbering the user's file).
// Best-effort: callers treat a thrown error / "error" status as a soft warning
// and keep going, mirroring the extension-install soft-fail philosophy.
export function disableClaudeCodeLoginPrompt(): VscodeLoginPromptResult {
	if (!existsSync(vscodeUserDataDir())) return { status: "skipped" };

	const path = vscodeSettingsPath();

	// No settings.json yet: create it (and its parent User/ dir) with just our
	// key. Default perms — this is a user-owned VS Code file, not a secret.
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, FRESH_CONTENTS);
		return { status: "created", path };
	}

	const text = readFileSync(path, "utf-8");

	// Empty / whitespace-only file: write a fresh object. modify() on truly
	// empty input is ambiguous, so handle it explicitly for a deterministic
	// outcome. (A comments-only file is NOT empty here and flows through
	// modify() below, which preserves the comment.)
	if (text.trim() === "") {
		writeFileSync(path, FRESH_CONTENTS);
		return { status: "added", path };
	}

	const errors: ParseError[] = [];
	const parsed = parse(text, errors, PARSE_OPTIONS);

	// Bail rather than risk corrupting a file we can't fully understand. An
	// empty / comments-only file parses to `undefined` with no errors — that's
	// fine, we treat it as an empty object and add the key below.
	if (errors.length > 0) {
		return { status: "error", warning: `${path} has JSON syntax errors` };
	}
	if (
		parsed !== undefined &&
		(typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
	) {
		return { status: "error", warning: `${path} root is not a JSON object` };
	}

	const existing =
		parsed === undefined
			? undefined
			: (parsed as Record<string, unknown>)[SETTING_KEY];
	if (existing === true) return { status: "unchanged", path };

	const edits = modify(text, [SETTING_KEY], true, {
		formattingOptions: FORMATTING,
	});
	writeFileSync(path, applyEdits(text, edits));
	return { status: existing === undefined ? "added" : "updated", path };
}
