---
description: Node-only CLI; pnpm + tsx + vitest + esbuild.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

This is a Node.js project. The shipped bin (`dist/index.js`) runs under plain Node, and the dev/build/test toolchain runs under Node too.

- Use `pnpm` for installs, scripts, and `pnpm exec`. Don't use `npm`/`yarn`/`bun install`.
- Use `tsx <file>` to run TypeScript/TSX directly (e.g. `pnpm dev` → `tsx src/index.tsx`). Don't use `ts-node`. The dev script is one-shot, not watch — codev is an interactive Ink CLI, so respawning mid-flow would corrupt the TTY.
- Use `vitest` for tests (`pnpm test`). Don't use `jest`.
- Use `esbuild` for bundling (driven by `build.ts` via `pnpm build`). Don't use `webpack`/`rollup`/`Bun.build`.
- Use `.env` via Node's built-in support (`node --env-file=.env`) or a per-script setup. Don't add `dotenv`.

## React

When writing or reviewing React/Ink components, consult the Vercel React best practices at `.claude/skills/vercel-react-best-practices/`. The rule index is `SKILL.md`; individual rules live in `rules/`, grouped by filename prefix:

- `advanced-*` — advanced hook patterns (effect event deps, event handler refs, init-once, use-latest)
- `async-*` — async/await and suspense (cheap-condition-before-await, defer-await, dependencies, parallel, suspense boundaries, API routes)
- `bundle-*` — bundle size (analyzable paths, barrel imports, conditional loading, dynamic imports, preload, deferring third-party)
- `client-*` — client-side browser concerns (event listeners, passive listeners, localStorage schema, SWR dedup)
- `js-*` — general JS perf (DOM/CSS batching, caching storage/props/results, early exit, hoisting regex, index maps, set/map lookups, toSorted, combining iterations, length-check first, requestIdleCallback)
- `rendering-*` — render-path optimizations (activity, content-visibility, hoisting JSX, hydration flicker/warnings, resource hints, defer/async scripts, SVG precision, useTransition for loading)
- `rerender-*` — re-render reduction (memo, derived state, functional setState, dependency lists, lazy state init, deferred reads, inline components, split hooks, transitions, useDeferredValue, useRef transient values, move-effect-to-event)
- `server-*` — SSR/server (after-nonblocking, auth actions, cache LRU/React, dedup props, hoist static I/O, no shared module state, parallel fetching, serialization)

Load a specific rule file only when the current work touches that topic; don't blanket-load the whole skill.

## Layout

The CLI is layered. Each layer has one job and only depends on the layer below it:

- `src/index.tsx` — argv dispatcher. Maps each command to its app component or logic function and exits.
- `src/<Name>App.tsx` — command-root Ink components, one per command (`InstallApp`, `UpdateApp`, `UploadApp`). Each is a state machine that wires together components from `src/components/` and orchestrates the command's flow. `index.tsx` mounts these via `render(<XApp />)`.
- `src/components/*.tsx` — reusable Ink components (Banner, Frame, Step, TaskList) and command-phase components (Install, Configure, Login, FetchApiKey, Update). Apps and other components import these; they never import apps.
- `src/lib/*.ts` — non-UI logic modules (`auth`, `configure`, `npm`, `paths`, `markdown`, `statistics`, `export`, `upload`, `run`, `restore`, `backend`, `help`, `const`, `reexec`, `supabase`). Components and apps import logic; logic never imports UI.
- `src/providers/*.ts` — agent-specific reader implementations used by `src/lib/export.ts` (one file per agent).

When adding a new command:

1. Add a `src/<Name>App.tsx` for its Ink root.
2. Put any phase-specific Ink components in `src/components/`.
3. Put non-UI logic in `src/lib/<name>.ts` (or a folder if it grows beyond a couple of files).
4. Wire it up in `src/index.tsx`.

## Imports

Use absolute imports with the `@/*` alias. Don't use relative imports.

```ts
// Good
import { InstallApp } from "@/InstallApp.js";
import { Banner } from "@/components/Banner.js";
import { runUpload } from "@/lib/upload.js";

// Bad
import { InstallApp } from "./InstallApp.js";
import { Banner } from "../components/Banner.js";
import { runUpload } from "./lib/upload.js";
```

## Validation

Always run these commands after making changes and ensure they pass:

- `pnpm fix` — lint and format with Biome
- `pnpm typecheck` — type-check with TypeScript
- `pnpm test` — run tests (Vitest)
- `pnpm build && node dist/index.js --version` — bundle the CLI and smoke-test it under Node. The shipped bundle runs under Node (`bin: dist/index.js`); the smoke run catches anything that compiles cleanly but fails at module-link time under Node's ESM loader.

## APIs

- Use `node:fs/promises` (`readFile`, `writeFile`) for async I/O. `node:fs` sync APIs (`readFileSync`, `writeFileSync`, `mkdirSync`, `chmodSync`, etc.) are fine when synchronous behavior is required.
- Use `node:crypto` for hashing (`createHash("sha256")`). Use `node:zlib` for gzip (`gzipSync`).
- Use `node:child_process` (`spawn`, `spawnSync`) or `execa` for shelling out.
- Use built-in `fetch` and `WebSocket` (available in Node 22+).
- **SQLite is built into Node** via `node:sqlite`. It stabilized in Node 23.5; on Node 22.5–23.4 it requires the `--experimental-sqlite` flag. `src/index.tsx` probes for the module at the entry of `case "upload"` and re-execs itself with the flag (via `src/lib/reexec.ts`) when the probe fails, so the rest of the code can `import { DatabaseSync } from "node:sqlite"` unconditionally.

## Testing

Use Vitest (`pnpm test`). The API is close to Jest's:

```ts#index.test.ts
import { test, expect } from "vitest";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For mocks and spies use `vi`: `vi.fn()` to create a mock function, `vi.spyOn(obj, "method")` to spy on an existing one. Use the `MockInstance` type from `vitest` to type-annotate spy variables.

When removing a string, label, or branch, don't pin its absence with `expect(...).not.toContain("removed string")`. The string is no longer anywhere in the source — nothing realistic could put it back — so the assertion only documents history. Update or delete the positive assertion instead. Negative assertions remain legitimate when the string is still emitted by **another branch of the same render**: e.g., a Confirm test that asserts the "no backup yet" arrow does NOT appear when rendering the "backup already exists" branch is pinning a conditional, not a deleted feature.

## Backup behavior

`configureClaudeCode` and `configureOpenCode` always replace the live config (`~/.claude/settings.json`, `~/.config/opencode/opencode.json`), but an existing `*.backup` is never overwritten. On the first run a backup is copied from the live config; every subsequent run skips the backup step and leaves the original `*.backup` in place. There is no prompt and no `overwriteBackups` option — preserving the user's pre-CoDev state is the whole point. `restoreTool` then renames `*.backup` back over the live file.

Claude Code owns **three** files, not one. Beyond `~/.claude/settings.json`, the install flow also touches `~/.claude.json` and `~/.claude/.credentials.json` via two functions in `src/lib/configure.ts`:

- `backupClaudeAuth()` — snapshots both files to `*.backup` (idempotent via `ensureBackup`) and leaves the originals untouched.
- `resetClaudeAuth()` — calls `backupClaudeAuth()` first, then overwrites `~/.claude.json` with `{hasCompletedOnboarding: true}` (so the CLI skips its first-run wizard) and removes `~/.claude/.credentials.json` (so the CLI can't reuse stale session auth that would conflict with the gateway API key in settings.json).

Both run in `SetupApp`'s `finalizing` Phase — silently (no visible Step), best-effort, after the user has clicked through every choice and Configure has succeeded. Which one fires depends on `creds`: any non-Skip path (`new` / `manual` / `existing`) ends up with `creds !== null` and runs `resetClaudeAuth` so the about-to-be-written gateway settings.json takes effect cleanly; the "Skip configuration" path ends up with `creds === null` and runs `backupClaudeAuth` so the user's existing Claude session keeps working. Deferring both halves to finalize means a mid-flow Ctrl-C leaves both files untouched on disk — no backup created, no destructive write. PATH shim install (`installShims`) is deferred to the same Phase for the same reason; the resume message in `SetupComplete` reads `shimsInstalled` to merge the activation hint.

On that same `creds !== null` branch, finalize also calls `disableClaudeCodeLoginPrompt()` (`src/lib/vscode-settings.ts`) whenever a Claude tool — CLI or either extension — was configured: CoDev now owns Claude's gateway auth via `settings.json`, so the Claude Code VS Code extension's interactive login prompt is redundant. It surgically sets `claudeCode.disableLoginPrompt: true` in VS Code's `User/settings.json` (per-platform path honoring `$APPDATA` / `$XDG_CONFIG_HOME`; gated on the VS Code user-data dir existing — absent ⇒ no-op), editing via `jsonc-parser`'s `modify` / `applyEdits` so comments, formatting, and every other setting survive. An already-`true` key is left byte-identical (no write); a malformed or non-object `settings.json` is left untouched. Unlike Claude's own config files this is a single-key edit on a heavily user-owned file, so it is deliberately **not** backed up and **not** part of `codev restore` — the additive, idempotent setting is simply left in place. The Skip path (`creds === null`) leaves it alone, since an unconfigured extension still needs its normal login.

The settings.json backup itself is independent and still happens at configure time via `configureClaudeCode` / `backupOnly`, regardless of the Skip choice.

The install flow's "Skip configuration" auth choice routes Configure through `backupOnly(tool)` instead of the per-agent `configure*` functions: it runs the same `ensureBackup` logic for the agent's main config file (so any existing live config is snapshotted to `*.backup` exactly once) and then exits without writing CoDev's own config. `Configure` accepts `creds: Credentials | null`; `null` is the signal to take this backup-only path, and the finalize Phase reads the same `creds === null` signal to pick `backupClaudeAuth` over `resetClaudeAuth`.

`restoreTool` returns `RestoreResult[]` — a length-1 array for single-file tools, length-3 for any Claude tool (settings.json + .claude.json + .credentials.json, in that order). Callers iterate. `runRestoreOrDelete` (in `src/lib/remove.ts`) rolls Claude's three results into one aggregated step (`restored 2 files; deleted 1 file (no backup)` style); `runRestore` / `runRestoreAll` (in `src/lib/restore.ts`) print one line per file.

`restoreTool` is invoked via `codev restore <agent>` (one tool) or bare `codev restore` (sweep all tools with a backup). The dispatcher accepts **launch names** — `claude`/`codex`/`opencode` — and `toolForRestoreAgent` in `src/lib/restore.ts` maps them to the internal `Tool` type. Behavior splits on path: `runRestore` (single) treats a missing backup as an error and exits 1; `runRestoreAll` (sweep) skips tools without backups silently, only erroring when *every* tool was skipped. Keep that asymmetry — it's right for both contexts.

## Config refresh and upload self-healing

Supabase coordinates (`supabase_url`, `supabase_anon_key`) and the public gateway base URL (`gateway_url`) are not baked into the source — they're fetched together from the backend's `POST /config` endpoint and cached in `~/.codev/auth.json`. `gateway_url` is read back via `AI_GATEWAY_URL()` / `AI_GATEWAY_OPENAI_URL()` in `src/lib/const.ts` (the latter derives the `<base>/v1` endpoint), which `configure.ts` and `backend.ts` fall back to whenever a flow has no explicit `baseUrl` (the SSO-key path). Like the Supabase accessors they hard-fail with a "run `codev install`" message if the cache was never populated. Two invariants keep that cache fresh:

1. **Every command that consumes Supabase coords refreshes config after a successful login.** `login()` itself does not call `refreshCodevConfig` — callers run it explicitly so the timing fits each flow. Today:
   - `InstallApp` awaits `refreshCodevConfig` inline between the install and key-choice steps. The `refreshing-config` Phase still exists as an internal state to block forward progress, but renders no visible Step.
   - `src/lib/upload.ts`'s `ensureAuth` calls `refreshCodevConfig` on the fresh-login branch (so the first Supabase attempt doesn't have to fail and retry just to populate the cache).
   - Tests that exercise real `login()` must mock `POST /codev-proxy/config` if (and only if) the caller also calls `refreshCodevConfig`.
2. **`runUpload` retries once on a "refreshable" error.** `isRefreshableError` (in `src/lib/upload.ts`) is deliberately narrow: `Missing supabase_…` from the cache accessors, or HTTP `401`/`403` from any Supabase or backend fetch. `5xx`, `404`, network errors, and timeouts are NOT retried — refreshing won't help and we'd amplify the outage. Per-file upload errors stay in `summary.errors` and don't trigger the pipeline-level retry. If you change `runSupabaseUpload`'s shape, keep that boundary intact.

## Diagnostic logging

`~/.codev` has two log homes — don't mix them up:

- `~/.codev/agent-logs/<project>/` — **conversation exports** (the data `codev upload` ships). `paths.ts#agentLogsDir` / `projectLogsDir`. Used to live at `~/.codev/logs/`; `runExport` still migrates legacy project folders over (directories only).
- `~/.codev/logs/codev-YYYYMMDD.ndjson` — **the CLI's own diagnostics** (`paths.ts#cliLogsDir`, written by `src/lib/log.ts`). One ECS NDJSON document per line.

`lib/log.ts` ground rules, in priority order: (1) logging can never break or block a command — every disk touch is wrapped, failed init degrades to no-op; (2) no secrets on disk — key-based redaction of structured fields plus pattern scrubbing of the serialized line (bearer values, JWTs, `sk-…` keys, sensitive query params); URLs persist as domain + path only. The one deliberate exception: the configured gateway API key, which `logApiKeyConfigured` writes verbatim via the `unsafeUnredacted` escape hatch — its only sanctioned use — during `codev install`/`config` (event `configure.api-key`, carried in `codev.api_key`, never the message); everything else stays redacted; (3) never write to stdout/stderr — Ink owns the TTY. Files are date-named (no rename rotation: the foreground CLI and the detached upload daemon append concurrently); retention prunes at init (14 days / 50 MB) and only touches the `codev-*.ndjson` pattern. Env knobs: `CODEV_LOG_LEVEL` (default `debug`, `silent` disables), `CODEV_LOG_DIR`.

`initLogging(command, argv)` runs in `index.tsx` before dispatch: every command gets `command.start`/`command.end` (sync exit hook) and crash capture (`uncaughtException`/`unhandledRejection` — handlers replicate Node's print-and-exit-1). Each process has a `trace.id`; `CODEV_TRACE_PARENT` carries the parent's id across the sqlite re-exec and the upload-daemon spawn (`codev.parent_trace_id`).

Instrumented seams — extend these rather than adding ad-hoc writes: `loggedFetch(endpoint, url, init)` wraps every direct fetch (start + completion docs; error bodies read from a `Response.clone()` so callers' streams stay intact; request headers/bodies never serialized); `npm.ts#execAsync` covers all shelled-out children (npm, `code`, JetBrains CLIs, codegraph) with exit code + stderr tail; `runAgent` logs agent launches with an **args count only** — agent args can carry prompt text and must never reach disk; `login()` and `runUpload` tee their status callbacks. Keep `event.action` to the taxonomy listed in `LogFields`.

Daemon specifics: `runUploadDaemon` logs `daemon.skip` / `daemon.run` documents to the NDJSON log; the detached child's own stdout/stderr are discarded (`stdio: ["ignore", "ignore", "ignore"]` in `spawnUploadDaemon`) — there is no separate `upload.log` sink, since the child runs through `index.tsx` and its diagnostics already land in the NDJSON log. `~/.codev/last-upload.json` is status, not logging, and stays.

The reader side is `src/lib/logs.ts` (`codev logs`): bare mode prints the most recent run, excluding this very invocation's trace and prior `logs` runs; `--trace <id>` accepts a prefix; child runs are linked via `codev.parent_trace_id`. Plain console output, no Ink.

Testing: logging is a silent no-op until `initLogging` runs, so ordinary tests need no setup and never write files. Tests that assert documents stub `CODEV_LOG_DIR`, call `initLogging(cmd, [], { installProcessHooks: false })` (so vitest's process stays free of our exit/crash listeners), and `resetLogging()` in `afterEach`. Related: `login()`'s force-login probe is keyed off `~/.codev/auth.json` — not the `~/.codev` dir — precisely because the logger creates `~/.codev/logs` at the entry of every command.

## CodeGraph integration

`src/lib/codegraph.ts` integrates the external [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) tool (a CLI + MCP server). Two surfaces:

1. **Install wiring.** Tools map to CodeGraph `--target` ids via `toolToCodegraphTarget` (the three CLI agents, plus both Claude Code *extension* variants → `claude`; Continue → none). The work is split in two:
   - **Install** (`ensureCodegraphInstalled` = `npm i -g @colbymchenry/codegraph`, always) runs *before* finalize, as a visible row in the `Install` `TaskList` (labeled with the npm package name, like the agent rows) (`src/components/Install.tsx`, keyed `CODEGRAPH_TASK_KEY`). In **install mode** it sits alongside the agent rows (parallel install). In **config mode** the agents are already installed, so `Install` is rendered with `includeAgents={false}` — a CodeGraph-only step titled "Installing CodeGraph", shown right after login (only when `codegraphTargets(tools).length > 0`; otherwise config skips straight to the post-login side-effects / key-choice). The `CODEGRAPH_TASK_KEY` sentinel is **not** a `Tool` — in install mode `handleInstallDone` splits it out of the survivor set (Configure/shims would choke on it) and excludes it from the all-failed fail-stop; in config mode the survivor set is just `tools` (the CodeGraph row is best-effort and never gates the agents).
   - **MCP wiring** (`setupCodegraph` → `runCodegraphInstall` = `codegraph install --target <csv> --location global --yes`) runs in `runFinalizeSideEffects`. `setupCodegraph` assumes CodeGraph is already installed — it only wires.

   The whole thing is **best-effort**: the install row soft-fails as a yellow ▲ (never a ✗, never affects the fail-stop), and a wiring failure becomes a `warning` result rendered as a ▲ row — neither aborts the CoDev flow. An empty target set returns `skipped` and renders nothing. CodeGraph's own `--yes` install skips putting itself on PATH, which is why CoDev installs the package itself (the MCP configs reference a bare `codegraph` command that must resolve at agent-launch time).

2. **Command passthrough.** `codev codegraph <args>` forwards verbatim to `codegraph <args>` via `forwardToCodegraph` (e.g. `codev codegraph init -y`). It mirrors `src/lib/run.ts#runAgent` (inherited stdio, SIGINT/SIGTERM swallowing, win32 `shell:true`) minus the shim-dir stripping and upload daemon — CodeGraph isn't a chat agent and isn't shimmed. ENOENT prints an install hint.

3. **Removal.** `codev remove` (`src/lib/remove.ts#runRemove`) runs `runCodegraphUninstall` (`codegraph uninstall --location global --yes`) before the config restores, to revert CodeGraph's MCP wiring across agents. It does NOT npm-uninstall the codegraph package (matching how remove leaves the codev-ai package). It's best-effort via a new `"warning"` `StepStatus`: if the codegraph package was already removed the command errors (ENOENT), and the step is a ▲ warning that's excluded from `anyFailed` — so the remove still succeeds. `RemoveApp` renders warning steps in both the success and failure views.

Spawn/exec are routed through stubbable indirections for tests: `codegraphRunner.spawn` (passthrough) and `lib/npm.ts#execAsync` (install). The Install/Config integration tests spy on both `ensureCodegraphInstalled` and `setupCodegraph` so neither the Install step nor finalize shells out.
