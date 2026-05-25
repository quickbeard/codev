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
- `src/lib/*.ts` — non-UI logic modules (`auth`, `configure`, `npm`, `paths`, `markdown`, `statistics`, `export`, `upload`, `run`, `restore`, `proxy`, `help`, `const`, `reexec`, `supabase`). Components and apps import logic; logic never imports UI.
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

The install flow's "Skip configuration" auth choice routes through `backupOnly(tool)` instead of the per-agent `configure*` functions: it runs the same `ensureBackup` logic (so any existing live config is snapshotted to `*.backup` exactly once) and then exits without writing CoDev's own config. It also does not call `bypassClaudeLogin` — skip means CoDev touches nothing the user didn't already have. `Configure` accepts `creds: Credentials | null`; `null` is the signal to take this backup-only path.

`restoreTool` is invoked via `codev restore <agent>` (one tool) or bare `codev restore` (sweep all tools with a backup). The dispatcher accepts **launch names** — `claude`/`codex`/`opencode` — and `toolForRestoreAgent` in `src/lib/restore.ts` maps them to the internal `Tool` type. Behavior splits on path: `runRestore` (single) treats a missing backup as an error and exits 1; `runRestoreAll` (sweep) skips tools without backups silently, only erroring when *every* tool was skipped. Keep that asymmetry — it's right for both contexts.

## Config refresh and upload self-healing

Supabase coordinates (`supabase_url`, `supabase_anon_key`) are not baked into the source — they're fetched from `codev-proxy`'s `POST /config` endpoint and cached in `~/.codev/auth.json`. Two invariants keep that cache fresh:

1. **Every command that consumes Supabase coords refreshes config after a successful login.** `login()` itself does not call `refreshCodevConfig` — callers run it explicitly so the timing fits each flow. Today:
   - `InstallApp` runs `refreshCodevConfig` as its own `refreshing-config` phase, right after the npm install completes.
   - `src/lib/upload.ts`'s `ensureAuth` calls `refreshCodevConfig` on the fresh-login branch (so the first Supabase attempt doesn't have to fail and retry just to populate the cache).
   - Tests that exercise real `login()` must mock `POST /codev-proxy/config` if (and only if) the caller also calls `refreshCodevConfig`.
2. **`runUpload` retries once on a "refreshable" error.** `isRefreshableError` (in `src/lib/upload.ts`) is deliberately narrow: `Missing supabase_…` from the cache accessors, or HTTP `401`/`403` from any Supabase or proxy fetch. `5xx`, `404`, network errors, and timeouts are NOT retried — refreshing won't help and we'd amplify the outage. Per-file upload errors stay in `summary.errors` and don't trigger the pipeline-level retry. If you change `runSupabaseUpload`'s shape, keep that boundary intact.
