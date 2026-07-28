# CoDev

CoDev — AI Coding Agent Hub. Install, configure, and manage multiple AI coding agents.

Requires Node.js ≥ 22.21 (Node 24+ recommended). 22.21 is the release that added
`HTTP_PROXY`/`HTTPS_PROXY` support to the Node 22 line — below it Node silently
ignores proxy settings, so sign-in cannot work behind a corporate proxy.

## Install

```bash
npm install -g codev-ai
```

Then run:

```bash
codevhub doctor    # check your environment and network first
codevhub install
```

After install, go to your project and type `codev`, `claude`, `codex`, or `opencode` to launch.

## Check your setup first: `codevhub doctor`

On a corporate network — behind a proxy, a TLS-inspecting gateway, or an
internal npm mirror — run this before `codevhub install`:

```bash
codevhub doctor
```

It is read-only (it installs and configures nothing) and checks, in order:

- **Environment** — Node version, npm, the global npm prefix (on `PATH` and
  writable), the npm registry/proxy configuration, your proxy and TLS
  environment variables, and whether the OS certificate store is readable.
- **Network** — the CoDev backend and the npm registry are actually reachable.
- **Account** — sign-in, gateway API key, CoDev configuration, and Supabase
  (used by `codevhub upload`).
- **LLM access** — the key is valid, models are listable, and a real one-token
  completion succeeds. Only the last of these proves inference is permitted.
- **This machine** — what is already installed, configured, and backed up.

When something fails it prints what happened, the most likely cause given your
proxy and TLS settings, the fix, and the raw error — never a bare
`fetch failed`. If the network checks fail it offers to re-run everything
through a proxy you type in, then prints the exact `export` / `setx` commands to
make the working settings permanent.

Use `codevhub doctor --force` to test a real sign-in instead of reusing a cached
session. Exit code is 0 when nothing failed (warnings do not fail it), 1 otherwise.

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
