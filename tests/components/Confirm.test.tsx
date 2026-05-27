import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Confirm, confirmTitle } from "@/components/Confirm.js";

afterEach(() => {
	cleanup();
});

// Ink's test renderer wraps text at 80 cols, so the heads-up sentence can
// be split across multiple lines. Collapse runs of whitespace to a single
// space so substring assertions don't have to know the wrap boundary.
function flatten(out: string): string {
	return out.replace(/\s+/g, " ");
}

describe("Confirm", () => {
	test("title is the heads-up warning", () => {
		const { lastFrame } = render(confirmTitle());
		expect(lastFrame()).toContain(
			"Heads up — CoDev will change your settings.",
		);
	});

	test("single tool renders one restore command", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} />,
		);
		const out = flatten(lastFrame() ?? "");
		expect(out).toContain("To revert to your pre-CoDev state, run");
		expect(out).toContain("codev restore claude");
		// No "and" or commas for a singleton.
		expect(out).not.toContain("codev restore claude,");
		expect(out).not.toContain("codev restore claude and");
	});

	test("two tools join with 'and' (no comma)", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm tools={["claude-code", "opencode"]} onConfirm={onConfirm} />,
		);
		const out = flatten(lastFrame() ?? "");
		expect(out).toContain("codev restore claude and codev restore opencode");
	});

	test("three tools use Oxford comma", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm
				tools={["claude-code", "codex", "opencode"]}
				onConfirm={onConfirm}
			/>,
		);
		const out = flatten(lastFrame() ?? "");
		expect(out).toContain(
			"codev restore claude, codev restore codex, and codev restore opencode",
		);
	});

	test("dedupes Continue's two editor variants to a single restore command", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm
				tools={["vscode-continue", "jetbrains-continue"]}
				onConfirm={onConfirm}
			/>,
		);
		const out = lastFrame() ?? "";
		// Editor-neutral alias appears once, not twice.
		expect(out).toContain("codev restore continue");
		const matches = out.match(/codev restore continue/g) ?? [];
		expect(matches.length).toBe(1);
	});

	test("dedupes Claude CLI + extension to a single restore command", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm
				tools={["claude-code", "vscode-claude-code"]}
				onConfirm={onConfirm}
			/>,
		);
		const out = lastFrame() ?? "";
		const matches = out.match(/codev restore claude/g) ?? [];
		expect(matches.length).toBe(1);
	});

	test("readOnly hides the YesNo prompt", () => {
		const onConfirm = vi.fn();
		const { lastFrame } = render(
			<Confirm tools={["claude-code"]} onConfirm={onConfirm} readOnly />,
		);
		const out = lastFrame() ?? "";
		// The sentence is still rendered as history.
		expect(out).toContain("codev restore claude");
		// YesNo's "(y/N)" prompt should not be present.
		expect(out).not.toContain("(y/N)");
		expect(out).not.toContain("(Y/n)");
	});
});
