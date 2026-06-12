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

After install, go to your project and type `claude`, `codex`, or `opencode` to launch.

## CodeGraph integration

When you run `codev install` (or `codev config`), CoDev also installs [CodeGraph](https://github.com/colbymchenry/codegraph) — a local, MCP-based code-intelligence server — and wires it into each agent you selected (Claude Code, Codex, OpenCode), user-wide (`--location global`). You can drive CodeGraph through CoDev — `codev codegraph <args>` is equivalent to `codegraph <args>`.

### Initialize your project

```bash
cd your-project
codev codegraph init        # initialize + index the current project (one time)
codev codegraph status      # show index status
```

## Switching between self-hosted and proprietary models

CoDev points your agents at a self-hosted AI gateway, but you can flip any agent back to its own provider (Anthropic for Claude Code, OpenAI for Codex, and so on) — and back to the gateway again — whenever you like. Because CoDev backs up your original config before it changes anything, the round-trip is safe and repeatable.

### Go back to the proprietary models

Restore each agent's pre-CoDev config:

```bash
codev restore claude     # one agent
codev restore codex
codev restore opencode
codev restore            # every agent at once
```

`codev restore <agent>` swaps the backup back over the live config, so the agent talks to its own provider again. With no argument, `codev restore` reverts every agent at once.

### Use the self-hosted models

Re-point your already-installed agents at the gateway and pick a model:

```bash
codev config
```

After each switching, if you have a session running, you might need to restart it with `claude -c`, `codex resume`, or `opencode -c` to resume your progress.

## Removing CoDev entirely

```bash
codev remove
```

After confirmation, this reverts your machine to its pre-CoDev state — including running `codegraph uninstall` to remove CodeGraph's MCP wiring from your agents. Add `--yes` (or `-y`) to skip the confirmation prompt.

CoDev itself is still installed globally — finish with:

```bash
npm uninstall -g codev-ai
```

Then restart your terminal.

## Diagnostic logs

Every codev command appends a structured diagnostic log to `~/.codev/logs/codev-YYYYMMDD.ndjson` — one [Elastic Common Schema](https://www.elastic.co/guide/en/ecs/current/index.html) JSON document per line. If a command misbehaves, this file shows what actually happened: each network request with its status and duration, every child process with its exit code and stderr tail, step-by-step flow progress, and any crash with a stack trace.

```bash
codev logs               # pretty-print the most recent run
codev logs --verbose     # also show each entry's codev.* detail (api_key, endpoints, …)
codev logs --trace <id>  # drill into one run (child runs are listed by the output above)
codev logs --path        # print the newest log file's path

# Or query the raw NDJSON directly — everything from today's failed runs:
jq 'select(.log.level == "error" or .log.level == "warn")' "$(codev logs --path)"
```

Details worth knowing:

- **Conversations are never logged, and most secrets are redacted.** OAuth codes, bearer tokens, JWTs, and signed-URL parameters are scrubbed twice over, and agent prompt text is never recorded (only argument counts). **One deliberate exception:** the gateway API key you configure during `codev install` / `codev config` is written to the log in cleartext (as the `configure.api-key` event, surfaced by `codev logs --verbose`) so a misconfigured key can be diagnosed — treat `~/.codev/logs` as sensitive. Conversation exports are separate data and live in `~/.codev/agent-logs/`.
- **Retention** is automatic: files older than 14 days are pruned, and the directory is capped at 50 MB.
- **Tuning:** `CODEV_LOG_LEVEL` (`debug` by default; `silent` disables logging), `CODEV_LOG_DIR` relocates the directory.

## Development

```bash
corepack enable
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

The bundled CLI is output to `dist/index.js`. Run it with:

```bash
pnpm start
```

## Lint & Format

```bash
pnpm fix
pnpm typecheck
```

## Test

```bash
pnpm test
```
