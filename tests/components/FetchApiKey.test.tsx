import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FetchApiKey } from "@/components/FetchApiKey.js";
import type * as auth from "@/lib/auth.js";
import * as backend from "@/lib/backend.js";

afterEach(() => {
	cleanup();
});

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-xyz",
		id_token: "id-xyz",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

describe("FetchApiKey", () => {
	test("calls onDone and renders a success line after a successful fetch", async () => {
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-test-123");

		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { lastFrame } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith("sk-test-123");
		expect(onFallback).not.toHaveBeenCalled();
		expect(lastFrame() ?? "").toContain("API key obtained successfully.");
	});

	test("shows retry prompt on first empty key", async () => {
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("");

		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { lastFrame } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));

		const output = lastFrame() ?? "";
		expect(output).toContain("Gateway returned an empty API key.");
		expect(output).toContain("Press Enter to retry");
		expect(output).not.toContain("Press Enter to enter credentials manually");
		expect(onDone).not.toHaveBeenCalled();
		expect(onFallback).not.toHaveBeenCalled();
	});

	test("retry on empty re-calls fetchApiKey with the same access_token", async () => {
		const fetchSpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockImplementationOnce(() => Promise.resolve(""))
			.mockImplementationOnce(() => Promise.resolve("sk-second-try"));
		fetchSpy.mockClear();

		const authData = fakeAuth();
		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { stdin } = render(
			<FetchApiKey auth={authData} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]).toEqual([authData.access_token]);
		expect(fetchSpy.mock.calls[1]).toEqual([authData.access_token]);
		expect(onDone).toHaveBeenCalledWith("sk-second-try");
		expect(onFallback).not.toHaveBeenCalled();
	});

	test("second empty result shows manual fallback prompt", async () => {
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("");

		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { stdin, lastFrame } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));

		const output = lastFrame() ?? "";
		expect(output).toContain("Gateway returned an empty API key again.");
		expect(output).toContain(
			"Press Enter to enter credentials manually, Ctrl-C to quit",
		);
		expect(onDone).not.toHaveBeenCalled();
		expect(onFallback).not.toHaveBeenCalled();
	});

	test("Enter on the manual fallback prompt calls onFallback", async () => {
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("");

		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { stdin } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));
		stdin.write("\r"); // first empty -> retry
		await new Promise((r) => setTimeout(r, 100));
		stdin.write("\r"); // second empty -> fallback
		await new Promise((r) => setTimeout(r, 100));

		expect(onFallback).toHaveBeenCalledTimes(1);
		expect(onDone).not.toHaveBeenCalled();
	});

	test("shows error and retry prompt on fetchApiKey rejection", async () => {
		vi.spyOn(backend, "fetchApiKey").mockRejectedValue(
			new Error("Backend /auth/exchange failed (502): boom"),
		);

		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { lastFrame } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));

		const output = lastFrame() ?? "";
		expect(output).toContain("Failed to fetch API key");
		expect(output).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(onDone).not.toHaveBeenCalled();
		expect(onFallback).not.toHaveBeenCalled();
	});

	test("Enter retries after a fetchApiKey error and succeeds on second attempt", async () => {
		const fetchSpy = vi
			.spyOn(backend, "fetchApiKey")
			.mockImplementationOnce(() => Promise.reject(new Error("transient")))
			.mockImplementationOnce(() => Promise.resolve("sk-recovered"));
		fetchSpy.mockClear();

		const onDone = vi.fn();
		const onFallback = vi.fn();
		const { stdin, lastFrame } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));
		expect(lastFrame() ?? "").toContain("Failed to fetch API key: transient");

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(onDone).toHaveBeenCalledWith("sk-recovered");
	});
});
