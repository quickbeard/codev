# CoDev

CoDev — AI Coding Agent Hub. Install, configure, and manage multiple AI coding agents.

## Install

```bash
npm install -g codev-ai
```

Then run:

```bash
codev install
```

## Commands

| Command                    | What it does                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `codev --help`, `-h`       | Show help                                                                                 |
| `codev --version`, `-v`    | Show version                                                                              |
| `codev install`            | Install and configure AI coding agents                                                    |
| `codev update`             | Update installed AI coding agents                                                         |
| `codev export`             | Export this directory's agent conversations to `~/.codev/logs/<project>/`                 |
| `codev claude`             | Run the `claude` CLI (forwards remaining arguments)                                       |
| `codev claude --restore`   | Restore `~/.claude/settings.json` from `~/.claude/settings.json.backup`                   |
| `codev codex`              | Run the `codex` CLI (forwards remaining arguments)                                        |
| `codev codex --restore`    | Restore `~/.codex/config.toml` from `~/.codex/config.toml.backup`                         |
| `codev opencode`           | Run the `opencode` CLI (forwards remaining arguments)                                     |
| `codev opencode --restore` | Restore `~/.config/opencode/opencode.json` from `~/.config/opencode/opencode.json.backup` |
| `codev logout`             | Sign out of SSO                                                                           |

> Codex requires Node.js ≥ 22, and CoDev itself enforces this on every invocation.

## Restoring a previous configuration

CoDev will replace `~/.claude/settings.json`, `~/.codex/config.toml`, and `~/.config/opencode/opencode.json` with new configs. Before writing its own config, CoDev backs up the specific file it would replace — other files in those directories are left untouched.

| Selection   | Backed up                                 |
| ----------- | ----------------------------------------- |
| Claude Code | `~/.claude/settings.json.backup`          |
| Codex       | `~/.codex/config.toml.backup`             |
| OpenCode    | `~/.config/opencode/opencode.json.backup` |

`settings.json`, `config.toml`, and `opencode.json` are **replaced** (not merged), so any keys you had before live only in the file backup.

### Existing backups

If a backup already exists from a prior CoDev run (`*.backup`), CoDev leaves it untouched and proceeds to replace the live config. The existing backup is assumed to be your pre-CoDev original and is never clobbered by later runs. To capture a fresh backup, delete the old `*.backup` first, then run `codev install` again.

### Restore

Use the built-in restore shortcut:

```bash
codev claude --restore
codev codex --restore
codev opencode --restore
```

Each command removes the active config file and renames the corresponding `*.backup` back into place. If no backup exists, the command prints a "No backup found" message and exits with code 1.

Or do it manually:

```bash
# Claude Code
mv ~/.claude/settings.json.backup ~/.claude/settings.json

# Codex
mv ~/.codex/config.toml.backup ~/.codex/config.toml

# OpenCode
mv ~/.config/opencode/opencode.json.backup ~/.config/opencode/opencode.json
```

If you have a session running, you might need to restart it with `claude -c`, `codex resume`, or `opencode -c` to resume your progress.

## Exporting conversation history

`codev export` reads each agent's on-disk session store, filters to conversations that belong to the current directory, and writes them as Markdown to `~/.codev/logs/<project>/<agent>/`. Nothing is uploaded — the files stay on your machine.

```
~/.codev/logs/works-repos-codev/
  claude-code/
    2026-04-27_18-32-05Z-help-me-fix-the.md
  codex/
    2026-04-27_19-15-22Z-refactor-auth.md
  opencode/
    2026-04-27_20-44-10Z-explain-the-build.md
  statistics.json
```

- The project subfolder is the current directory's path with the home prefix stripped and non-alphanumeric characters replaced with `-`.
- Filenames are `<UTC-timestamp>-<slug>.md`, where the slug comes from the first user message in the session.
- `statistics.json` records per-session metadata (message counts, byte size, provider, timestamps), keyed by session ID and merged across runs.
- Existing files are overwritten on each run; sessions with no activity in the current directory are quietly skipped.
