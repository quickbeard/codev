import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test } from "vitest";
import { Banner } from "@/components/Banner.js";
import pkg from "../../package.json" with { type: "json" };

afterEach(() => {
	cleanup();
});

describe("Banner", () => {
	test("renders the CODEV wordmark", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		// The lowercase "codev" pixel wordmark ported from CoDev Code.
		expect(output).toContain("█▀▀▀ █▀▀█");
		expect(output).toContain("▀▀▀▀ ▀▀▀▀");
	});

	test("renders the subtitle", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain("AI Coding Agent Hub");
	});

	test("renders the version", () => {
		const { lastFrame } = render(<Banner />);

		const output = lastFrame() ?? "";
		expect(output).toContain(`v${pkg.version}`);
	});
});
