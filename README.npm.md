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

## Commands

| Command                      | What it does                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `codev --help`, `-h`         | Show help                                                                                 |
| `codev --version`, `-v`      | Show version                                                                              |
| `codev install`              | Install and configure AI coding agents                                                    |
| `codev update`               | Update installed AI coding agents                                                         |
| `codev upload`               | Export this directory's agent conversations to `~/.codev/logs/<project>/` and upload them to the backend |
| `codev claude`               | Run the `claude` CLI (forwards remaining arguments)                                       |
| `codev claude --restore`     | Restore `~/.claude/settings.json` from `~/.claude/settings.json.backup`                   |
| `codev codex`                | Run the `codex` CLI (forwards remaining arguments)                                        |
| `codev codex --restore`      | Restore `~/.codex/config.toml` from `~/.codex/config.toml.backup`                         |
| `codev opencode`             | Run the `opencode` CLI (forwards remaining arguments)                                     |
| `codev opencode --restore`   | Restore `~/.config/opencode/opencode.json` from `~/.config/opencode/opencode.json.backup` |
| `codev logout`               | Sign out of SSO                                                                           |

## What `codev install` does

`codev install` runs an interactive setup that:

1. Prompts you to select which agents to install (Claude Code, Codex, OpenCode).
2. **Signs you in via SSO.** Login is mandatory — the browser flow opens and CoDev waits for the callback. If you're already signed in (`~/.codev/auth.json` has a valid session), this step auto-completes.
3. Installs the selected agent packages via `npm`.
4. If you have a saved API key from a previous run, validates it against the gateway.
5. Asks how you want to authenticate the agents:
   - **Reuse existing API Key** — only offered if the saved key is still valid.
   - **Get a new API Key** — issues a fresh key from the CoDev gateway using your SSO session. If the gateway returns an empty key, you get one retry before falling back to the manual entry path.
   - **I have my own API Key** — type the gateway URL, key, and model manually.
   - **Skip configuration** — leave each selected agent's config untouched. CoDev still creates the `*.backup` snapshot of any existing config (see [Restoring a previous configuration](#restoring-a-previous-configuration) below) so you can revert later, but it does not write its own gateway settings.
6. Writes the agent configs (replacing the live config; see [Restoring a previous configuration](#restoring-a-previous-configuration) below). Skipped if you chose **Skip configuration**.

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

## Uploading conversation history

`codev upload` reads each agent's on-disk session store, filters to conversations that belong to the current directory, and writes them as Markdown to `~/.codev/logs/<project>/<agent>/`. It then ships any new or changed Markdown logs to the CoDev Supabase backend. Authentication uses the same SSO login as `codev install`; if you're not signed in, the browser flow runs first.

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
- Existing local files are overwritten on each run; sessions with no activity in the current directory are quietly skipped.
- Files are SHA-256 hashed and compared against the server. Unchanged logs are skipped, so re-running is cheap.
- Each upload records the previous version it replaces, so the backend keeps history rather than overwriting.
- Payloads are gzipped over the wire.
- If Supabase rejects the request with `401`/`403`, or the cached Supabase coordinates are missing from `~/.codev/auth.json`, CoDev refreshes the cache from `codev-proxy` and retries the upload exactly once before surfacing the error. Transient `5xx`/network failures are not retried.
