import { VERSION } from "@/lib/const.js";

export function printVersion() {
	console.log(`${VERSION}`);
}

export function printHelp() {
	console.log(`CoDev — AI Coding Agent Hub

Usage: codev <command> [options]

Commands:
  install             Install and configure AI coding agents
  config              Configure existing AI coding agents
  update              Update installed AI coding agents
  upload              Export and upload logs to the monitor module
                      (--force, -f re-uploads every conversation)
  model               Switch the default model
  restore [agent]     Restore an agent's pre-CoDev config from its *.backup
                      (no arg processes every agent)
  login               Sign in to SSO (--force to bypass cached session)
  logout              Sign out of SSO
  remove              Revert this machine to its pre-CoDev state (--yes to skip prompt)
  --version, -v       Show version
  --help, -h          Show this help
`);
}
