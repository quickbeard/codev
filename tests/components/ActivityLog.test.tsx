import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";
import { ActivityLog } from "@/components/ActivityLog.js";
import type { RequestRecord } from "@/lib/log.js";
import type { CommandRecord } from "@/lib/npm.js";

function cmd(over: Partial<CommandRecord> = {}): CommandRecord {
	return { command: "npm -v", durationMs: 120, ok: true, ...over };
}

function req(over: Partial<RequestRecord> = {}): RequestRecord {
	return {
		method: "POST",
		url: "https://backend.example.com/config",
		status: 200,
		durationMs: 300,
		ok: true,
		...over,
	};
}

describe("ActivityLog", () => {
	test("renders nothing when the run recorded no activity", () => {
		const { lastFrame } = render(<ActivityLog commands={[]} requests={[]} />);
		expect(lastFrame()?.trim()).toBe("");
	});

	test("lists each command with its duration under a Commands run header", () => {
		const { lastFrame } = render(
			<ActivityLog
				commands={[
					cmd({ command: "npm -v" }),
					cmd({ command: "npm config get proxy", durationMs: 95 }),
				]}
				requests={[]}
			/>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Commands run");
		expect(frame).toContain("npm -v");
		expect(frame).toContain("(120ms)");
		expect(frame).toContain("npm config get proxy");
		expect(frame).toContain("(95ms)");
		// Nothing was requested, so that section stays off the screen entirely
		// rather than printing a bare header.
		expect(frame).not.toContain("Endpoints contacted");
	});

	test("marks a failed command with ✗", () => {
		const { lastFrame } = render(
			<ActivityLog
				commands={[cmd({ command: "npm ping", ok: false })]}
				requests={[]}
			/>,
		);
		expect(lastFrame()).toContain("✗ npm ping");
	});

	test("lists each endpoint with its method, url and status", () => {
		const { lastFrame } = render(
			<ActivityLog
				commands={[]}
				requests={[req({ url: "https://backend.example.com/config" })]}
			/>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Endpoints contacted");
		expect(frame).toContain("POST https://backend.example.com/config → 200");
		expect(frame).toContain("(300ms)");
		expect(frame).not.toContain("Commands run");
	});

	// The section reports whether the network let us through, not whether the
	// call succeeded. Several doctor probes are unauthenticated and answer 401
	// by design; scoring those on `ok` painted them red directly under check
	// rows that correctly called them a pass.
	test("scores a 401 as reached, not failed", () => {
		const { lastFrame } = render(
			<ActivityLog
				commands={[]}
				requests={[req({ status: 401, ok: false })]}
			/>,
		);
		expect(lastFrame()).toContain("✓ POST https://backend.example.com/config");
	});

	test("scores a request that never got a response as failed", () => {
		const { lastFrame } = render(
			<ActivityLog
				commands={[]}
				requests={[req({ status: null, ok: false })]}
			/>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("✗ POST https://backend.example.com/config");
		expect(frame).toContain("no response");
	});

	test("renders both sections together", () => {
		const { lastFrame } = render(
			<ActivityLog commands={[cmd()]} requests={[req()]} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Commands run");
		expect(frame).toContain("Endpoints contacted");
		// Commands first: they are what ran locally, before anything left the box.
		expect(frame.indexOf("Commands run")).toBeLessThan(
			frame.indexOf("Endpoints contacted"),
		);
	});
});
