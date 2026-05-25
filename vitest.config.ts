import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": resolve(import.meta.dirname, "src"),
		},
	},
	test: {
		include: ["tests/**/*.test.{ts,tsx}"],
		environment: "node",
		// Windows CI runners are 2-3× slower and load-variable: a render that
		// takes 30 ms locally can take a couple of seconds under contention.
		// Vitest's defaults (5 s test, 10 s hook) leave no slack, so Ink tests
		// surface as flaky "Test timed out in 5000ms" / "Hook timed out in
		// 10000ms" failures. Genuine hangs still surface — they just take a
		// bit longer.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
