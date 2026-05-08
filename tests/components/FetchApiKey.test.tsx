import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { FetchApiKey } from "@/components/FetchApiKey.js";
import * as auth from "@/lib/auth.js";
import * as proxy from "@/lib/proxy.js";

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
		spyOn(proxy, "fetchApiKey").mockResolvedValue("sk-test-123");
		const saveSpy = spyOn(auth, "saveApiKey").mockImplementation(() => {});

		const onDone = mock();
		const onFallback = mock();
		const { lastFrame } = render(
			<FetchApiKey auth={fakeAuth()} onDone={onDone} onFallback={onFallback} />,
		);

		await new Promise((r) => setTimeout(r, 100));

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith("sk-test-123");
		expect(saveSpy).toHaveBeenCalledWith({ apiKey: "sk-test-123" });
		expect(onFallback).not.toHaveBeenCalled();
		expect(lastFrame() ?? "").toContain("API key obtained successfully.");
	});

	test("shows retry prompt on first empty key", async () => {
		spyOn(proxy, "fetchApiKey").mockResolvedValue("");

		const onDone = mock();
		const onFallback = mock();
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
		const fetchSpy = spyOn(proxy, "fetchApiKey")
			.mockImplementationOnce(() => Promise.resolve(""))
			.mockImplementationOnce(() => Promise.resolve("sk-second-try"));
		spyOn(auth, "saveApiKey").mockImplementation(() => {});
		fetchSpy.mockClear();

		const authData = fakeAuth();
		const onDone = mock();
		const onFallback = mock();
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
		spyOn(proxy, "fetchApiKey").mockResolvedValue("");

		const onDone = mock();
		const onFallback = mock();
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
		spyOn(proxy, "fetchApiKey").mockResolvedValue("");

		const onDone = mock();
		const onFallback = mock();
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
		spyOn(proxy, "fetchApiKey").mockRejectedValue(
			new Error("Proxy /auth/exchange failed (502): boom"),
		);

		const onDone = mock();
		const onFallback = mock();
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
		const fetchSpy = spyOn(proxy, "fetchApiKey")
			.mockImplementationOnce(() => Promise.reject(new Error("transient")))
			.mockImplementationOnce(() => Promise.resolve("sk-recovered"));
		spyOn(auth, "saveApiKey").mockImplementation(() => {});
		fetchSpy.mockClear();

		const onDone = mock();
		const onFallback = mock();
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
