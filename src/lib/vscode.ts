import { execAsync } from "@/lib/npm.js";

// Marketplace ID for the Continue extension (continuedev.continue).
export const CONTINUE_EXTENSION_ID = "continue.continue";

// Marketplace ID for the Claude Code VS Code extension.
export const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";

// Soft-fail outcome: `null` means the extension was installed (or already
// present and the install reported success). `{ warning }` means we couldn't
// install — either `code` wasn't on PATH or the install ran and failed
// (proxy, marketplace down, certificate error, etc.). Either way we let the
// install flow continue; the per-tool config file is the source of truth and
// Configure surfaces the warning to the user with a manual-install hint. We
// never want a transient extension-install failure to abort the entire
// `codevhub install` flow.
export type InstallExtensionResult = null | { warning: string };

async function installExtension(
	extensionId: string,
): Promise<InstallExtensionResult> {
	const r = await execAsync("code", [
		"--install-extension",
		extensionId,
		"--force",
	]);
	if (!r.error) return null;
	if (r.error.code === "ENOENT") {
		return { warning: "VS Code launcher not found on PATH" };
	}
	return { warning: r.stderr.trim() || r.error.message };
}

export function installContinueExtension(): Promise<InstallExtensionResult> {
	return installExtension(CONTINUE_EXTENSION_ID);
}

export function installClaudeCodeExtension(): Promise<InstallExtensionResult> {
	return installExtension(CLAUDE_CODE_EXTENSION_ID);
}

// Whether `code` resolves on PATH. Used by `codevhub update` to decide
// whether to schedule the VS Code extension update — if the launcher
// isn't there, CoDev has nothing to update (the user never had us
// auto-install in the first place, or has since removed the CLI).
export async function isCodeCliAvailable(): Promise<boolean> {
	const r = await execAsync("code", ["--version"]);
	return !r.error;
}
