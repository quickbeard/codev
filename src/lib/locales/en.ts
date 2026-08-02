/**
 * The source-of-truth message catalog. Every other locale is typed as
 * `Record<MessageKey, string>`, so adding a key here without adding it to the
 * others is a `pnpm typecheck` failure.
 *
 * Keys are namespaced by surface: `common.*` for anything shared, then one
 * namespace per screen. A `<key>_one` / `<key>_other` pair is a plural, read
 * through `tCount` rather than `t`.
 *
 * What does NOT belong here: brand names ("CoDev Code", "Claude Code"), command
 * and flag names, env var names, provider/model ids, URLs, status-union
 * literals, and the control-flow `new Error(...)` sentinels the Ink apps throw
 * to force a non-zero exit. Those are contract values, not display text.
 */
export const en = {
	// Shared affordances. The keyboard hints were duplicated verbatim across
	// four different pickers before they landed here.
	"common.hint.move_confirm": "(↑/↓ to move, Enter to confirm)",
	"common.hint.move_select_confirm":
		"(↑/↓ to move, Space to select, Enter to confirm)",
	"common.hint.help": "Run `codevhub --help` to see all commands.",
	"common.happy_coding": "Happy coding! 🎉",
	"common.done": "Done!",
	"common.file_one": "{count} file",
	"common.file_other": "{count} files",

	// Task-list rows. One complete sentence per verb per state — `{label}` is a
	// package or product name and is never translated.
	"tasklist.install.running": "Installing {label}...",
	"tasklist.install.done": "Installed {label}",
	"tasklist.install.failed": "Failed to install {label}: {error}",
	"tasklist.update.running": "Updating {label}...",
	"tasklist.update.done": "Updated {label}",
	"tasklist.update.failed": "Failed to update {label}: {error}",
	"tasklist.warning": "Warning: {warning}",
	"tasklist.unknown": "unknown",
	"tasklist.unknown_error": "unknown error",

	// The wordmark itself is a logo, not text. Only the tagline under it is
	// translatable; the version token beside it is not.
	"banner.tagline": "AI Coding Agent Hub",

	// Pickers. The product names on the rows ("CoDev Code", "VS Code", …) are
	// brand names and stay in every locale, so only the titles and the
	// always-on suffix appear here.
	"tool_select.title.install": "Select the AI agent(s) to install",
	"tool_select.title.config": "Select the AI agent(s) to configure",
	"tool_select.locked.install": "(always installed)",
	"tool_select.locked.config": "(always configured)",
	"editor_select.title": "Select the editor(s) to install extensions in",
	"auth_method.title": "Choose configuration method",
	"auth_method.new": "Get a new API Key",
	"auth_method.manual": "I have my own API Key",
	"auth_method.existing": "Reuse existing API Key",
	"auth_method.skip": "Skip configuration",

	// Closing frame. The shell command in the reload hint is a literal the user
	// types, so it sits between the two halves rather than inside either.
	"setup.complete.restart_terminal": "Done! Restart your terminal.",
	"setup.complete.reload_shell_prefix": "Done! Run ",
	"setup.complete.reload_shell_suffix": " to reload your shell.",

	// Shared across every prompt that offers a retry or validates a field.
	"common.continue_question": "Continue?",
	"common.retry_hint": "Press Enter to retry, Ctrl-C to quit",
	"common.field_required": "{field} is required",

	// Install / Update rows.
	"install.hint.vscode_continue":
		"You can install the Continue extension yourself later.",
	"install.hint.jetbrains_continue":
		"You can install the Continue plugin yourself later.",
	"install.hint.vscode_claude_code":
		"You can install the Claude Code extension yourself later.",
	"install.hint.jetbrains_claude_code":
		"You can install the Claude Code plugin yourself later.",
	"install.codegraph_failed": "CodeGraph not installed: {error}",
	"update.codegraph_failed": "CodeGraph not updated: {error}",
	"update.detecting": "Checking installed agents...",
	"update.nothing": "Nothing to update.",
	"update.title": "Updating packages",

	// Configure step. `{tool}` is a product name and is not translated.
	"configure.title": "Configure tools",
	"configure.configured": "Configured {tool}",
	"configure.failed": "Configure failed: {error}",

	// Pre-install confirmation. The restore commands between the two halves are
	// literal commands, joined by Intl.ListFormat rather than hard-coded commas.
	"confirm.title": "Heads up — CoDev will change your settings.",
	"confirm.revert_prefix": "To revert to your pre-CoDev state, run ",

	// Doctor's row renderer. The check labels, details and diagnosis prose come
	// from lib/doctor.ts and are deliberately still English — only this
	// component's own chrome is translated.
	"checklist.env_passed_one": "{count} environment check passed",
	"checklist.env_passed_other": "{count} environment checks passed",
	"checklist.field.what": "What happened",
	"checklist.field.cause": "Likely cause",
	"checklist.field.fix": "What to do",
	"checklist.field.context": "Context",
	"checklist.field.raw": "Raw",

	"activity.commands": "Commands run",
	"activity.endpoints": "Endpoints contacted",
	"activity.no_response": "no response",

	// Proxy prompt. The example addresses themselves are literals; only the note
	// beside each one is translated.
	"proxy_prompt.title": "Configure a proxy",
	"proxy_prompt.examples": "Examples:",
	"proxy_prompt.example.ip_port": "IP and port",
	"proxy_prompt.example.host_port": "hostname and port",
	"proxy_prompt.example.with_login": "proxy that needs a login",
	"proxy_prompt.example.full_url":
		"full URL (http:// is assumed if you omit it)",
	"proxy_prompt.failed_with_proxy":
		"The network checks failed even though a proxy is configured ({proxy}).",
	"proxy_prompt.wrong_address":
		"If that address is wrong, enter the correct one and CoDev will re-run the checks with it.",
	"proxy_prompt.failed_no_proxy":
		"The network checks failed. If this machine reaches the internet through a proxy, enter it here and CoDev will re-run the checks with it applied.",
	"proxy_prompt.not_written":
		"Nothing is written to disk — this applies to this run only.",
	"proxy_prompt.field.keep":
		"Proxy (host:port), or Enter to keep the current one: ",
	"proxy_prompt.field.skip": "Proxy (host:port), or Enter to skip: ",
	"proxy_prompt.retrying": "Retrying via {proxy}…",
	"proxy_prompt.skipped": "Skipped.",
	"proxy_prompt.error.port_only":
		'"{input}" looks like just the port. Enter the host too, e.g. 10.0.0.1:{input}',
	"proxy_prompt.error.invalid":
		"That doesn't look like a proxy address. Use host:port, e.g. 10.0.0.1:8080",

	// Sign-in.
	"login.title": "Login",
	"login.failed": "Login failed: {reason}",
	"login.signed_in": "✓ Signed in",
	"login.signed_in_as": "✓ Signed in as {email}",
	"login.starting": "Starting sign-in...",
	"login.waiting": "Waiting for sign-in to complete in your browser...",
	"login.browser_didnt_open": "Browser didn't open? Sign in here ",
	"login.copied": "(copied!)",
	"login.press_c": "(press C to copy)",
	"login.paste_caption":
		"After signing in, copy the code shown and paste it here:",
	"login.no_keyboard":
		"This terminal can't accept keyboard input, so the paste-back fallback is unavailable — finish sign-in in the browser.",

	"paste_back.caption_1":
		"After you sign in, the page shows an authorization code.",
	"paste_back.caption_2":
		'Use its "Copy code" button, then paste the code here:',
	"paste_back.completing": "Completing sign-in...",
	"paste_back.submit_hint": "Press Enter to submit.",

	"fetch_key.title": "Fetching new API Key",
	"fetch_key.pending": "Fetching API key from gateway...",
	"fetch_key.success": "✓ API key obtained successfully.",
	"fetch_key.failed": "Failed to fetch API key: {reason}",
	"fetch_key.empty": "Gateway returned an empty API key.",
	"fetch_key.empty_again": "Gateway returned an empty API key again.",
	"fetch_key.manual_hint":
		"Press Enter to enter credentials manually, Ctrl-C to quit",

	"manual_creds.title": "Enter API credentials",
	"manual_creds.field.provider_name": "Provider Name",
	"manual_creds.field.api_url": "API URL",
	"manual_creds.field.api_key": "API Key",
	"manual_creds.empty": "(empty)",
	"manual_creds.hint":
		"Press Enter to confirm each field (Provider Name is optional).",

	// ADMIN/SUPERADMIN are server-side role names and stay verbatim.
	"admin_login.title": "Admin login",
	"admin_login.field.username": "Username",
	"admin_login.field.password": "Password",
	"admin_login.signing_in": "Signing in...",
	"admin_login.attempt": "(attempt {n} of {max})",
	"admin_login.gave_up": "({max} failed attempts — giving up)",
	"admin_login.only_admin":
		"Only ADMIN/SUPERADMIN accounts can sign in here — regular users use `codevhub login`.",

	"model_select.title": "Choose default model",
	"model_select.loading": "Fetching available models...",
	"model_select.failed": "Failed to fetch models: {error}",

	// `codevhub login`. The admin form's own strings live under admin_login.*.
	"login.admin.logged_in_as": "✓ Logged in as {username} ({role})",
	"login.signing_out": "Signing out previous session",
	"login.revoking": "Revoking tokens...",

	// `codevhub remove`. The per-step labels and details come from lib/remove.ts
	// and are still English; only this screen's own copy is translated.
	"remove.confirm":
		"Everything will be reverted to the pre-CoDev state. Do you want to proceed?",
	"remove.aborted": "Abort.",
	"remove.running": "Removing CoDev components...",
	"remove.kept_one":
		"Kept {count} config file CoDev didn't write — your own settings were left untouched:",
	"remove.kept_other":
		"Kept {count} config files CoDev didn't write — your own settings were left untouched:",
	"remove.some_failed": "✗ Some steps failed:",
	"remove.success_prefix": "Removed successfully. You can now run ",
	"remove.success_suffix":
		" to remove the CoDev package. Restart your terminal to apply.",

	// `codevhub upload`. The live status line comes from lib/upload.ts's
	// onStatus callback and is still English; this is only its initial value.
	"upload.uploading": "Uploading logs...",
	"upload.browser_url": "If the browser didn't open, visit this URL manually:",
	"upload.no_keyboard":
		"This terminal can't accept keyboard input — finish sign-in in the browser.",
	"upload.failed": "✗ Upload failed",
	"upload.none_found": "No conversations found for this project.",
	"upload.looked_in": "codevhub looked in:",
	"upload.launch_hint":
		"If you used an AI agent here, make sure you launched it from this directory.",
	"upload.uploaded": "✓ Uploaded {uploaded}/{found} conversation logs",
	"upload.skipped": "Skipped {count} unchanged logs",
	"upload.failed_logs": "Failed {count} logs:",
	"upload.more": "(+{count} more)",
	"upload.source": "Source: {dir}",

	// `codevhub skill pull`. The skill's own name and the agent labels are
	// proper nouns and are interpolated, not translated.
	"skill_pull.title": "Install {name} skill",
	"skill_pull.title_generic": "Install skill",
	"skill_pull.resolving": "Resolving skill...",
	"skill_pull.installing": "Installing...",
	"skill_pull.install_to": "Install {name} to:",
	"skill_pull.location.current": "Current directory (recommended)",
	"skill_pull.location.global": "Global",
	"skill_pull.which_agents": "For which agents?",
	"skill_pull.toggle_hint": "space toggles · enter confirms",
	"skill_pull.no_keyboard":
		"This terminal cannot supply keystrokes, so the install prompts cannot be shown.\nPass --here, --global, or --dir <path> to choose a location without them.",

	// `codevhub skill push`. DRAFT / PUBLIC are server-side status values and
	// stay verbatim inside the translated sentences.
	"skill_push.title": "Publish skill to the hub",
	"skill_push.step.uploading": "Uploading",
	"skill_push.step.saving": "Saving metadata",
	"skill_push.step.submitting": "Submitting for review",
	"skill_push.step.approving": "Approving (admin)",
	"skill_push.mode.draft": "Save as a DRAFT (not submitted).",
	"skill_push.mode.auto_approve":
		"Upload, submit, and auto-approve to PUBLIC (admin only).",
	"skill_push.mode.submit": "Upload and submit for review.",
	"skill_push.no_keyboard":
		"This terminal cannot supply keystrokes, so the confirmation prompt cannot be shown.\nRe-run with --json to publish without confirming.",
	"skill_push.preparing": "Preparing archive...",
	"skill_push.archive_one": "{fileName}  ({count} file, {size})",
	"skill_push.archive_other": "{fileName}  ({count} files, {size})",
	"skill_push.and_more": "  … and {count} more",
	"skill_push.excluded": "Excluded: {list}",
	"skill_push.confirm": "Publish this skill?",
	"skill_push.checking_signin": "Checking sign-in...",
	"skill_push.publishing": "Publishing",
	"skill_push.cancelled": "Cancelled.",

	// `codevhub model`. The tool names in the summary line are brand names,
	// joined by Intl.ListFormat.
	"model.loading": "Loading saved credentials...",
	"model.no_creds_prefix": "No CoDev credentials found. Run ",
	"model.no_tools_prefix": "No CoDev-configured AI tools found. Run ",
	"model.run_install_suffix": " first.",
	"model.re_auth":
		"Saved API key was rejected — refreshing credentials before continuing.",
	"model.reauth_failed":
		"Re-authentication did not produce a valid key. Run 'codevhub install' to refresh credentials.",
	"model.update_configs_title": "Update tool configs",
	"model.updating": "Updating tool configs...",
	"model.updated_prefix": "Default model updated to ",
	"model.updated_middle": " for ",
	"model.opencode_prefix": "In ",
	"model.opencode_suffix": ", switch models anytime with /models.",

	// `codevhub doctor`. The check labels, details, diagnoses and Next-steps
	// lines all come from lib/doctor.ts and are still English — this is the
	// screen's own chrome only.
	"doctor.group.environment": "Environment",
	"doctor.group.network": "Network",
	"doctor.group.account": "Account & credentials",
	"doctor.group.llm": "LLM access",
	"doctor.group.state": "This machine",
	"doctor.step.activity": "Activity",
	"doctor.step.result": "Result",
	"doctor.summary.ok":
		"✓ Everything checks out. You're ready to run `codevhub install`.",
	"doctor.summary.warned":
		"▲ {warned} warning(s). `codevhub install` should work, but read the notes below first.",
	"doctor.summary.failed":
		"✗ {failed} check(s) failed. Fix these before running `codevhub install`.",
	"doctor.summary.failed_with_warnings":
		"✗ {failed} check(s) failed, {warned} warning(s). Fix these before running `codevhub install`.",
	"doctor.next_steps": "Next steps",
	"doctor.report_saved":
		"Full report saved to {path} — attach it to a support ticket.",

	// `codevhub install` / `codevhub config`. The pre-flight check rows and the
	// gateway's own failure reasons come from lib/doctor.ts and lib/backend.ts
	// and are still English.
	"setup.abort": "Abort.",
	"setup.preflight.title": "Checking your environment",
	"setup.preflight.hint":
		"Run `codevhub doctor` for the full check — npm, network, sign-in and LLM access — plus setup instructions.",
	"setup.installing.packages": "Installing packages",
	"setup.installing.codegraph": "Installing CodeGraph",
	"setup.refresh.title": "Refresh CoDev config",
	"setup.saved_key.title": "Checking saved API key",
	"setup.saved_key.verifying": "Verifying with gateway...",
	"setup.saved_key.valid": "Saved API key is valid.",
	"setup.saved_key.invalid":
		"Saved API key is no longer valid; choose another method.",
	"setup.saved_key.unverifiable": "Could not verify saved API key: {error}",
	"setup.model_list.title": "Model list",
	"setup.model_list.fallback":
		"Couldn't fetch the model list ({error}); using fallback model {model}.",
	"setup.gateway.title": "Verifying gateway access",
	"setup.gateway.sending": "Sending a test request to {model}…",
	"setup.gateway.the_model": "the model",
	"setup.gateway.ok": "Gateway accepted a test request.",
	"setup.gateway.warning_hint":
		"Config was still written, but your agents will hit this same error — fix gateway access (model entitlement, budget, or region/IP), then relaunch.",
	"setup.codegraph.title": "Set up CodeGraph",
	"setup.codegraph.running": "Setting up CodeGraph…",
	"setup.codegraph.incomplete": "CodeGraph setup did not complete.",
	"setup.codegraph.wired": "Wired CodeGraph into {targets}.",
	"setup.ripgrep.title": "File search",
	"setup.ripgrep.failed":
		"Could not stage ripgrep for CoDev Code: {error}. File search may be empty on Windows — install ripgrep (winget install BurntSushi.ripgrep.MSVC) and restart the agent.",

	// The `--help` screen, as one message per locale. Command names, flags and
	// their arguments are fixed tokens the user types — only the descriptions
	// beside them are translated, and the column alignment is maintained by hand.
	"help.body":
		'CoDev \u2014 AI Coding Agent Hub\n\nUsage: codevhub [command] [options]\n\nBare `codevhub` opens CoDev Code, the built-in coding agent, in the current\ndirectory (`codev` opens it directly). Any command not listed below is\npassed through to it as well \u2014 `codevhub run "fix the tests"`,\n`codevhub serve`, `codevhub models`, and so on.\n\nHub commands:\n  doctor              Check your environment and network before installing\n                      (Node version, npm, proxy/TLS, sign-in, LLM access;\n                      --force to test a real sign-in instead of the cached one)\n  install             Install and configure AI coding agents\n  config              Configure existing AI coding agents\n  update              Update installed AI coding agents\n  init                Build the knowledge graph\n  upload              Export and upload logs to the monitor module\n                      (--force, -f re-uploads every conversation)\n  model               Switch the default model\n  restore [agent]     Restore an agent\'s pre-CoDev config\n                      (no arg processes every agent)\n  logs                Show the last run from the diagnostic log\n                      (--path newest file, --trace <id> one run, --verbose extra detail)\n  login               Sign in to SSO (--force to bypass cached session,\n                      --admin for interactive admin sign-in, or\n                      --username <u> --password <p> for non-interactive admin sign-in)\n  logout              Sign out (SSO and admin session)\n  remove              Revert this machine to its pre-CoDev state (--yes to skip prompt)\n  --version, -v       Show version\n  --help, -h          Show this help\n\nSkill hub:\n  skill search <query>   Search the public skill hub\n                         (--json for machine-readable output,\n                         --limit <n> to cap results, default 20)\n  skill pull <name>      Download and install a skill for your agents\n                         (prompts for location and agents; --here or --global to\n                         set the scope, --agent <list> or --all-agents to set the\n                         agents, --dir <path> for an exact path, --force to\n                         overwrite; --json for machine-readable output)\n  skill push <path>      Publish a skill (a directory with SKILL.md, or a .zip)\n                         (previews and confirms before upload; --draft-only to stop\n                         at DRAFT, --auto-approve for admins, --json for output)\n',

	// Dispatcher-level output. Usage lines are deliberately absent: they are
	// command signatures, and lib/skill-install.ts's PULL_USAGE (out of this
	// round's scope) would still print English beside a translated one.
	"cli.node_too_old":
		"CoDev requires Node.js >= {min} (Node {recommended} recommended). Current version: {current}.\nBelow {min}, Node ignores HTTP_PROXY/HTTPS_PROXY entirely, so sign-in cannot work behind a corporate proxy.\nDownload: {url}",
	"cli.login.credentials_together":
		"codevhub login: --username and --password must be provided together.",
	"cli.logged_out": "Logged out.",
	"cli.not_logged_in": "Not logged in.",
	"cli.unknown_agent": "Unknown agent: {agent}. Valid: {valid}.",
	"cli.unknown_agents": "Unknown agent(s): {agents}. Valid: {valid}.",
	"cli.unknown_skill_subcommand":
		"Unknown skill subcommand: {sub}. Valid: search, pull, push.",
	"cli.codegraph_dir_created":
		"Created the local {dir} directory. You can commit it if you'd like to share the knowledge graph with your team.",
	"cli.no_tools_for_hook":
		"No CoDev-installed tools found. Run `codevhub install` first, or specify agents explicitly: `codevhub hook claude|codex|opencode`.",
	"cli.shims_installed": "Installed shims in {dir}",
	"cli.shims_patched": "  patched {path}",
	"cli.shims_path_updated": "  updated user PATH",
	"cli.shims_none": "No CoDev shims installed.",
	"cli.shims_removed": "Removed {count} shim(s) from {dir}",
	"cli.shims_cleaned": "  cleaned {path}",
} as const;

export type MessageKey = keyof typeof en;
