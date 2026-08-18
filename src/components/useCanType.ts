import { useStdin } from "ink";

/**
 * Whether this terminal can supply keystrokes — i.e. whether it is safe to mount
 * a `useInput`. Ask this before rendering any prompt; see lib/tty.ts for why
 * (Git Bash on Windows gives Ink a pipe, and Ink throws from `useInput`'s mount
 * effect rather than degrading).
 *
 * Read from Ink's stdin context rather than `process.stdin`, so it is the exact
 * value Ink itself gates raw mode on — and stays correct when the stream is not
 * the process's own (ink-testing-library, or a custom `render({stdin})`).
 *
 * The `Boolean` is load-bearing, not defensive tidiness. Ink computes
 * `isRawModeSupported = stdin.isTTY`, and on a pipe Node leaves `isTTY`
 * **undefined**, not false — while `useInput` skips raw mode only on
 * `options.isActive === false`, a strict comparison. Forwarding the raw
 * `undefined` therefore reads as "active" and throws the very error this exists
 * to prevent. A unit test cannot catch it either: ink-testing-library's fake
 * stdin sets a real boolean, so only a piped real run reproduces it.
 */
export function useCanType(): boolean {
	return Boolean(useStdin().isRawModeSupported);
}
