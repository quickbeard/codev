import { vi } from "vitest";

// Global safety net: never launch a real browser during tests.
//
// Both browser openers (`browserOpener` in src/lib/auth.ts and
// src/lib/skillhub.ts) import the `open` package and call it to spawn a tab.
// Stubbing the package here to a no-op makes it structurally impossible for any
// test — present or future, even one that forgets to mock a component's login
// side-effects — to open a real browser window. Tests that need to assert on
// browser launches still spy on `browserOpener.open` (which now calls this
// no-op) or replace it outright.
vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));
