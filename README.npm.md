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
codev codegraph init -y     # initialize + index the current project (one time)
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
