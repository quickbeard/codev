---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

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

- `bun run fix` — lint and format with Biome
- `bun run typecheck` — type-check with TypeScript
- `bun test` — run tests
- `bun run build && node dist/index.js --version` — bundle the CLI and smoke-test it under Node. The shipped bundle runs under Node (`bin: dist/index.js`), not Bun, so anything that links cleanly under `bun dev` but breaks under Node's ESM loader (e.g. a stray `bun:` import) will only surface here. `bun dev` alone is not enough.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- SQLite is runtime-split: production runs under Node and uses the built-in `node:sqlite`; `bun test` uses `bun:sqlite`. Production modules that need SQLite (e.g. `src/providers/opencode.ts`) pick the driver at runtime via `typeof Bun !== "undefined"` and dynamic imports — never put a top-level `import ... from "bun:sqlite"` in any module reachable from `src/index.tsx`, because Node's ESM loader rejects the `bun:` scheme with `ERR_UNSUPPORTED_ESM_URL_SCHEME` at link time. `node:sqlite` is gated behind `--experimental-sqlite` on Node 22.5–23.4; `src/index.tsx` re-execs itself with that flag at the entry of `case "upload"` (via `src/lib/reexec.ts`) when the runtime probe fails, so the rest of the code can import `node:sqlite` unconditionally.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` for async reads/writes. `node:fs` sync APIs (`readFileSync`, `writeFileSync`, `mkdirSync`, `chmodSync`, etc.) are fine when synchronous behavior is required — Bun.file is async-only.
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Backup behavior

`configureClaudeCode` and `configureOpenCode` always replace the live config (`~/.claude/settings.json`, `~/.config/opencode/opencode.json`), but an existing `*.backup` is never overwritten. On the first run a backup is copied from the live config; every subsequent run skips the backup step and leaves the original `*.backup` in place. There is no prompt and no `overwriteBackups` option — preserving the user's pre-CoDev state is the whole point. `restoreTool` then renames `*.backup` back over the live file.

The install flow's "Skip configuration" auth choice routes through `backupOnly(tool)` instead of the per-agent `configure*` functions: it runs the same `ensureBackup` logic (so any existing live config is snapshotted to `*.backup` exactly once) and then exits without writing CoDev's own config. It also does not call `bypassClaudeLogin` — skip means CoDev touches nothing the user didn't already have. `Configure` accepts `creds: Credentials | null`; `null` is the signal to take this backup-only path.

## Config refresh and upload self-healing

Supabase coordinates (`supabase_url`, `supabase_anon_key`, `supabase_proxy_url`) are not baked into the source — they're fetched from `codev-proxy`'s `POST /config` endpoint and cached in `~/.codev/auth.json`. Two invariants keep that cache fresh:

1. **`login()` always ends with `refreshCodevConfig`** — including the cached "already logged in" branch. Don't add another early return that skips it; the whole point is that every successful login leaves the cache fresh. Tests that exercise real `login()` must mock `POST /codev-proxy/config` to stay hermetic.
2. **`runUpload` retries once on a "refreshable" error.** `isRefreshableError` (in `src/lib/upload.ts`) is deliberately narrow: `Missing supabase_…` from the cache accessors, or HTTP `401`/`403` from any Supabase or proxy fetch. `5xx`, `404`, network errors, and timeouts are NOT retried — refreshing won't help and we'd amplify the outage. Per-file upload errors stay in `summary.errors` and don't trigger the pipeline-level retry. If you change `runSupabaseUpload`'s shape, keep that boundary intact.
