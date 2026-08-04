import { Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";

/**
 * Render `node` in a terminal that cannot supply keystrokes — Git Bash on
 * Windows, where Ink sees a pipe and reports no raw mode (see lib/tty.ts).
 *
 * ink-testing-library's stdin always reports `isTTY: true` and its `render`
 * takes no options, so the flag has to be flipped on the instance afterwards.
 * Ink recomputes `isRawModeSupported` on every render, so the rerender is what
 * makes it take effect.
 *
 * The inert first tree is the load-bearing part: the flag must already be false
 * when the component under test *mounts*. A real terminal never gains and then
 * loses raw mode mid-run, and simulating that raced — `rerender` schedules
 * rather than renders, so under load an async effect could resolve first, reach
 * a phase that activates `useInput` while raw mode still looked available, and
 * leave Ink's `setRawMode` to throw once the flag flipped underneath it. That
 * froze the frames and timed the test out. Reproducible on demand by awaiting a
 * `setTimeout` between the mount and the flip.
 */
export function renderWithoutRawMode(node: ReactElement) {
	const instance = render(<Text> </Text>);
	instance.stdin.isTTY = false;
	instance.rerender(node);
	return instance;
}

/**
 * The last frame that actually rendered something.
 *
 * Prefer this over `lastFrame()` whenever the assertion is about what an app
 * left on screen just before it exited. Ink writes an **empty** frame when it
 * unmounts, so `lastFrame()` returns `""` from then on. An app that shows its
 * final message and exits ~20ms later leaves a 20ms window in which a 20ms poll
 * has to land; miss it and the predicate can never become true again, which
 * reads as a hang and times the test out under load.
 */
export function lastNonEmptyFrame(frames: string[]): string {
	for (let i = frames.length - 1; i >= 0; i--) {
		const frame = frames[i];
		if (frame !== undefined && frame.trim() !== "") return frame;
	}
	return "";
}
