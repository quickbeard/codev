import { execAsync } from "@/lib/npm.js";

// Marketplace ID for the Continue extension (continuedev.continue).
export const CONTINUE_EXTENSION_ID = "continue.continue";

// Best-effort install of the Continue VSCode extension. `code` may not be on
// PATH (user runs VSCode from a launcher; never opened the command palette's
// "Shell Command: Install 'code' command in PATH"); that's not a CoDev failure,
// so ENOENT resolves null and the install proceeds. Any other failure (the
// `code` CLI ran but returned non-zero — network, marketplace down, etc.) is
// surfaced as an error so the user sees the real cause in the TaskList row.
export async function installContinueExtension(): Promise<string | null> {
	const r = await execAsync("code", [
		"--install-extension",
		CONTINUE_EXTENSION_ID,
		"--force",
	]);
	if (!r.error) return null;
	if (r.error.code === "ENOENT") return null;
	return r.stderr.trim() || r.error.message;
}

// Surface to the UI whether the auto-install path will actually run. Used by
// the Configure step to decide whether to append a "install Continue manually"
// hint to its post-install resume message — if `code` is missing entirely, the
// best-effort install above silently no-ops, and the user needs to know.
export async function isCodeCliAvailable(): Promise<boolean> {
	const r = await execAsync("code", ["--version"]);
	return !r.error;
}
