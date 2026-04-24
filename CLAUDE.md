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

## Imports

Use absolute imports with the `@/*` alias. Don't use relative imports.

```ts
// Good
import { App } from "@/App.js";
import { Banner } from "@/components/Banner.js";

// Bad
import { App } from "./App.js";
import { Banner } from "../components/Banner.js";
```

## Validation

Always run these commands after making changes and ensure they pass:

- `bun run fix` — lint and format with Biome
- `bun run typecheck` — type-check with TypeScript
- `bun test` — run tests
- `bun run build` — bundle the CLI for distribution

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
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
