# CoDev

CoDev — AI Coding Agent Hub. Install, configure, and manage multiple AI coding agents.

Requires Node.js ≥ 22.5 (Node 24+ recommended).

## Install

```bash
npm install -g codev-ai
```

Then run:

```bash
codevhub install
```

After install, go to your project and type `codev`, `claude`, `codex`, or `opencode` to launch.

## CodeGraph integration

When you run `codevhub install` or `codevhub config`, CoDev also installs [CodeGraph](https://github.com/colbymchenry/codegraph) — a local, MCP-based, pre-indexed code-knowledge-graph tool — and wires it into each agent you select (Claude Code, Codex, OpenCode, etc.). Because your codebase is pre-indexed, agents can look up symbols, references, and structure straight from the graph instead of repeatedly grepping and reading files to find their way around. That means **fewer tool calls and fewer tokens** per task — the agent spends its context on the work rather than on rediscovering the codebase.

### Initialize your project

```bash
cd your-project
codevhub init        # initialize + index the current project (one time)
```

## Switching between self-hosted and proprietary models

CoDev points your agents at a self-hosted AI gateway, but you can flip any agent back to its own provider (Anthropic for Claude Code, OpenAI for Codex, and so on) — and back to the gateway again — whenever you like. Because CoDev backs up your original config before it changes anything, the round-trip is safe and repeatable.

### Go back to the proprietary models

Restore each agent's pre-CoDev config:

```bash
codevhub restore claude     # one agent
codevhub restore codex
codevhub restore opencode
codevhub restore            # every agent at once
```

`codevhub restore <agent>` swaps the backup back over the live config, so the agent talks to its own provider again. With no argument, `codevhub restore` reverts every agent at once.

### Use the self-hosted models

Re-point your already-installed agents at the gateway and pick a model:

```bash
codevhub config
```

After each switching, if you have a session running, you might need to restart it with `claude -c`, `codex resume`, or `opencode -c` to resume your progress.

## Removing CoDev entirely

```bash
codevhub remove
```

After confirmation, this reverts your machine to its pre-CoDev state — including running `codegraph uninstall` to remove CodeGraph's MCP wiring from your agents. Add `--yes` (or `-y`) to skip the confirmation prompt.

CoDev itself is still installed globally — finish with:

```bash
npm uninstall -g codev-ai
```

Then restart your terminal.

## Diagnostic logs

Every codevhub command appends a structured diagnostic log to `~/.codev/logs/codev-YYYYMMDD.ndjson` — one [Elastic Common Schema](https://www.elastic.co/guide/en/ecs/current/index.html) JSON document per line. If a command misbehaves, this file shows what actually happened: each network request with its status and duration, every child process with its exit code and stderr tail, step-by-step flow progress, and any crash with a stack trace.

```bash
codevhub logs               # pretty-print the most recent run
codevhub logs --verbose     # also show each entry's codev.* detail (api_key, endpoints, …)
codevhub logs --trace <id>  # drill into one run (child runs are listed by the output above)
codevhub logs --path        # print the newest log file's path

# Or query the raw NDJSON directly — everything from today's failed runs:
jq 'select(.log.level == "error" or .log.level == "warn")' "$(codevhub logs --path)"
```

Details worth knowing:

- **Conversations are never logged, and most secrets are redacted.** OAuth codes, bearer tokens, JWTs, and signed-URL parameters are scrubbed twice over, and agent prompt text is never recorded (only argument counts). **One deliberate exception:** the gateway API key you configure during `codevhub install` / `codevhub config` is written to the log in cleartext (as the `configure.api-key` event, surfaced by `codevhub logs --verbose`) so a misconfigured key can be diagnosed — treat `~/.codev/logs` as sensitive. Conversation exports are separate data and live in `~/.codev/agent-logs/`.
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
