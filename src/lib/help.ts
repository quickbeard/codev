import { VERSION } from "@/lib/const.js";

export function printVersion() {
	console.log(`${VERSION}`);
}

export function printHelp() {
	console.log(`CoDev — AI Coding Agent Hub

Usage: codev <command> [options]

Commands:
  install             Install and configure AI coding agents
  update              Update installed AI coding agents
  upload              Export and upload logs to the monitor module
  model               Switch the default model
  claude --restore    Restore ~/.claude/settings.json from ~/.claude/settings.json.backup
  codex --restore     Restore ~/.codex/config.toml from ~/.codex/config.toml.backup
  opencode --restore  Restore ~/.config/opencode/opencode.json from ~/.config/opencode/opencode.json.backup
  logout              Sign out of SSO
  remove              Revert this machine to its pre-CoDev state (--yes to skip prompt)
  --version, -v       Show version
  --help, -h          Show this help
`);
}
