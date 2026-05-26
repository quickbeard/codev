import { execAsync } from "@/lib/npm.js";

// JetBrains Marketplace plugin ID for Continue. Matches the bundle ID inside
// the .jar so `<bin> installPlugins` resolves it.
export const CONTINUE_INTELLIJ_PLUGIN_ID =
	"com.github.continuedev.continueintellijextension";

// JetBrains Marketplace plugin ID for Claude Code.
export const CLAUDE_CODE_INTELLIJ_PLUGIN_ID = "com.anthropic.claude-code";

// Shell launcher names we probe. Limited to PyCharm/IntelliJ IDEA/GoLand for
// now — each batch-mode invocation boots the IDE headless and takes several
// seconds, so we keep the probe list small. Users with other JetBrains IDEs
// (WebStorm, RubyMine, …) fall through to the manual-install hint.
//
// Windows install: the Toolbox "Generate shell scripts" feature writes
// `idea.cmd` / `pycharm.cmd` / `goland.cmd` under whatever directory the
// user picked. Our `execAsync` helper uses `shell: true` on win32 (see
// npm.ts), so the shell resolves the `.cmd` suffix automatically — we
// still spell the launcher without an extension here.
export const JETBRAINS_CLIS = ["idea", "pycharm", "goland"] as const;

// Soft-fail outcome — matches vscode.ts's InstallExtensionResult. `null`
// means at least one IDE accepted the install and no other IDE we tried
// returned a hard error. `{ warning }` covers two cases: nothing on PATH
// (all-ENOENT), or one or more IDEs ran the command and returned non-zero.
export type InstallPluginResult = null | { warning: string };

// Best-effort install of a JetBrains plugin. Runs `<bin> installPlugins
// <plugin-id>` against every CLI on PATH, sequentially — IDE batch boots
// fight each other if parallelized and the user only needs the plugin in
// IDEs they actually use, so wall time scales with IDEs-on-PATH × ~few
// seconds. ENOENT on a probe is normal ("user doesn't have that IDE");
// non-ENOENT failures are aggregated into one warning so the user sees
// every IDE that failed in a single hint.
async function installPlugin(pluginId: string): Promise<InstallPluginResult> {
	let installed = 0;
	const errors: string[] = [];
	for (const bin of JETBRAINS_CLIS) {
		const r = await execAsync(bin, ["installPlugins", pluginId]);
		if (!r.error) {
			installed++;
			continue;
		}
		if (r.error.code === "ENOENT") continue;
		const msg = r.stderr.trim() || r.error.message;
		errors.push(`${bin}: ${msg}`);
	}
	if (errors.length > 0) {
		const prefix =
			installed > 0 ? "installed for some IDEs but failed for others — " : "";
		return { warning: `${prefix}${errors.join("; ")}` };
	}
	if (installed === 0) {
		return {
			warning:
				"JetBrains launcher not found on PATH (PyCharm / IntelliJ IDEA / GoLand)",
		};
	}
	return null;
}

export function installContinuePlugin(): Promise<InstallPluginResult> {
	return installPlugin(CONTINUE_INTELLIJ_PLUGIN_ID);
}

export function installClaudeCodePlugin(): Promise<InstallPluginResult> {
	return installPlugin(CLAUDE_CODE_INTELLIJ_PLUGIN_ID);
}

// Whether at least one of the JetBrains launchers resolves on PATH. Used
// by `codev update` to decide whether to schedule the plugin update —
// short-circuits on the first responder so we don't pay the launcher-
// probe cost for every IDE when one will do.
export async function isAnyJetBrainsCliAvailable(): Promise<boolean> {
	for (const bin of JETBRAINS_CLIS) {
		const r = await execAsync(bin, ["--version"]);
		if (!r.error) return true;
	}
	return false;
}
