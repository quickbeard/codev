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
  model               Switch the default model
  skill               Browse, install, upload and publish skills (--help for subcommands)
  restore [agent]     Restore an agent's pre-CoDev config from its *.backup
                      (no arg processes every agent)
  login               Sign in to SSO (--force to bypass cached session)
  logout              Sign out of SSO
  remove              Revert this machine to its pre-CoDev state (--yes to skip prompt)
  --version, -v       Show version
  --help, -h          Show this help
`);
}

export function printSkillHelp() {
	console.log(`Browse, install, and publish skills on SkillHub.

Usage: codev skill <subcommand> [options]

Discovery:
  search [query]              Find public skills on SkillHub
  install <name>              Install a skill locally
  open                        Open SkillHub website in browser
  leaderboard                 Show trending, top rated, most downloaded
  user <username>             View a user's profile and public skills

My skills:
  my                          List your skills and their status
  upload <path>               Upload a skill (saves as Draft)
  publish <name>              Submit a Draft skill for admin review
  namespaces                  List namespaces you belong to
  ns <slug>                   List skills in a namespace

Options:
  --help, -h                  Show help for a subcommand

Web: https://netmind.viettel.vn/netmindhub

Run codev skill <subcommand> --help for subcommand details.
`);
}

export function printSkillSearchHelp() {
	console.log(`Search public skills on SkillHub.

Usage: codev skill search [query]

Arguments:
  query   Keyword to filter skills (optional — omit to list all)

Examples:
  codev skill search              List all available skills
  codev skill search minimax      Find skills matching "minimax"
  codev skill search pdf          Find PDF-related skills
`);
}

export function printSkillInstallHelp() {
	console.log(`Download and install a skill to your AI coding agent.

Usage: codev skill install <name> [options]

Arguments:
  name   Skill name from SkillHub (use "codev skill search" to find names)

Options:
  --agent claude|opencode   Agent to install into (default: claude)
  --force, -f               Overwrite if already installed

Examples:
  codev skill install minimax-pdf
  codev skill install minimax-pdf --agent opencode
  codev skill install taste-skill --force
  codev skill install taste-skill --agent opencode --force
`);
}

export function printSkillUploadHelp() {
	console.log(`Upload a skill to SkillHub (saves as Draft or Private).

Usage: codev skill upload <path> [options]

Arguments:
  path   Path to a skill directory or .zip file

Options:
  --namespace <slug>   Upload into a namespace (skill becomes Private)
  --submit             Also submit for admin review after upload
  --help, -h           Show this help

What happens:
  Without --submit:  Skill is saved as Draft (only you can see it)
                     Run \`codev skill publish <name>\` to submit later
  With --submit:     Skill is uploaded and immediately submitted for review

Examples:
  codev skill upload ./my-skill/
  codev skill upload ./my-skill/ --submit
  codev skill upload ./my-skill/ --namespace my-team
  codev skill upload ./my-skill.zip --namespace my-team --submit
`);
}

export function printSkillPublishHelp() {
	console.log(`Submit a Draft skill for admin review.

Usage: codev skill publish <name>

Arguments:
  name   Name of your Draft or Private skill

What happens:
  Your skill moves to "Under Review" status. A SkillHub admin will
  review it and either approve (→ Public) or reject with feedback.
  Run \`codev skill my\` to check the current status.

Examples:
  codev skill publish my-skill
`);
}
