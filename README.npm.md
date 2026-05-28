# CoDev

CoDev — AI Coding Agent Hub. Install, configure, and manage multiple AI coding agents.

Requires Node.js ≥ 22.5 (Node 24+ recommended).

## Install

```bash
npm install -g codev-ai
```

Then run:

```bash
codev install
```

After install, type `claude`, `codex`, or `opencode` to launch.

## Restoring a previous configuration

CoDev will replace `~/.claude/settings.json`, `~/.codex/config.toml`, and `~/.config/opencode/opencode.json` with new configs. For Claude Code, CoDev also resets the CLI's auth state so the new gateway credentials aren't shadowed: it rewrites `~/.claude.json` to skip the onboarding wizard, and removes `~/.claude/.credentials.json` so stale session auth can't take precedence. Before writing or removing any file, CoDev backs it up. If a backup already exists from a prior CoDev run (`*.backup`), CoDev leaves it untouched and proceeds. The existing backup is assumed to be your pre-CoDev original and is never clobbered by later runs.

| Selection   | Backed up                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/settings.json.backup`<br>`~/.claude.json.backup`<br>`~/.claude/.credentials.json.backup` |
| Codex       | `~/.codex/config.toml.backup`                                                                       |
| OpenCode    | `~/.config/opencode/opencode.json.backup`                                                           |

`settings.json`, `config.toml`, and `opencode.json` are **replaced** (not merged), so any keys you had before live only in the file backup.

### Restore

Use the built-in `restore` subcommand:

```bash
codev restore claude
codev restore codex
codev restore opencode
```

If you have a session running, you might need to restart it with `claude -c`, `codex resume`, or `opencode -c` to resume your progress.

## Removing CoDev entirely

```bash
codev remove
```

After confirmation, this reverts your machine to its pre-CoDev state. Add `--yes` (or `-y`) to skip the confirmation prompt.

CoDev itself is still installed globally — finish with:

```bash
npm uninstall -g codev-ai
```

Then restart your terminal.
