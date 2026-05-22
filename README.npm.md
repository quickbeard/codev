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

CoDev will replace `~/.claude/settings.json`, `~/.codex/config.toml`, and `~/.config/opencode/opencode.json` with new configs. Before writing its own config, CoDev backs up the specific file it would replace. If a backup already exists from a prior CoDev run (`*.backup`), CoDev leaves it untouched and proceeds to replace the live config. The existing backup is assumed to be your pre-CoDev original and is never clobbered by later runs.

| Selection   | Backed up                                 |
| ----------- | ----------------------------------------- |
| Claude Code | `~/.claude/settings.json.backup`          |
| Codex       | `~/.codex/config.toml.backup`             |
| OpenCode    | `~/.config/opencode/opencode.json.backup` |

`settings.json`, `config.toml`, and `opencode.json` are **replaced** (not merged), so any keys you had before live only in the file backup.

### Restore

Use the built-in restore shortcut:

```bash
codev claude --restore
codev codex --restore
codev opencode --restore
```

Each command removes the active config file and renames the corresponding `*.backup` back into place. If you have a session running, you might need to restart it with `claude -c`, `codex resume`, or `opencode -c` to resume your progress.

You can also do it manually:

```bash
# Claude Code
mv ~/.claude/settings.json.backup ~/.claude/settings.json

# Codex
mv ~/.codex/config.toml.backup ~/.codex/config.toml

# OpenCode
mv ~/.config/opencode/opencode.json.backup ~/.config/opencode/opencode.json
```

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
