import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Login } from "@/components/Login.js";
import * as auth from "@/lib/auth.js";

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

describe("Login", () => {
	test("shows 'Press Enter' when onReady is called", async () => {
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(() => {}, "https://sso.test/authorize?x=1", () => null);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Press Enter to open the browser and login");
	});

	test("shows log messages from login", async () => {
		vi.spyOn(auth, "login").mockImplementation((onLog) => {
			onLog("Starting SSO login...");
			onLog("Already logged in as test@example.com");
			return Promise.resolve(fakeAuth());
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Starting SSO login...");
		expect(output).toContain("Already logged in as test@example.com");
	});

	test("shows error and retry prompt on login failure", async () => {
		vi.spyOn(auth, "login").mockImplementation(() => {
			return Promise.reject(new Error("Connection refused"));
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Login failed: Connection refused");
		expect(output).toContain("Press Enter to retry, Ctrl-C to quit");
		expect(onDone).not.toHaveBeenCalled();
	});

	test("surfaces err.cause when present (real-world: fetch failed → DNS detail)", async () => {
		vi.spyOn(auth, "login").mockImplementation(() => {
			const err = new TypeError("fetch failed");
			(err as Error & { cause?: unknown }).cause = new Error(
				"getaddrinfo ENOTFOUND sso.example.com",
			);
			return Promise.reject(err);
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain(
			"Login failed: fetch failed (getaddrinfo ENOTFOUND sso.example.com)",
		);
	});

	test("opens browser when Enter is pressed", async () => {
		const openBrowserFn = vi.fn();
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(openBrowserFn, "https://sso.test/authorize?x=1", () => null);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { stdin } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		expect(openBrowserFn).toHaveBeenCalled();
	});

	test("does not open browser before Enter is pressed", async () => {
		const openBrowserFn = vi.fn();
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(openBrowserFn, "https://sso.test/authorize?x=1", () => null);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		expect(openBrowserFn).not.toHaveBeenCalled();
	});

	test("does not show the fallback URL before Enter is pressed", async () => {
		const url = "https://sso.test/authorize?x=1";
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(() => {}, url, () => null);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		// The URL is only revealed after the user presses Enter to open the
		// browser, so it must not be on screen while we're still waiting.
		expect(lastFrame() ?? "").not.toContain(url);
	});

	test("shows the authorize URL as a manual fallback after Enter is pressed", async () => {
		const url = "https://sso.test/authorize?x=1";
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(() => {}, url, () => null);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain(
			"If the browser didn't open, visit this URL manually",
		);
		expect(output).toContain(url);
	});

	test("calls onDone with the auth data after a successful login", async () => {
		const authData = fakeAuth();
		vi.spyOn(auth, "login").mockImplementation(() => Promise.resolve(authData));

		const onDone = vi.fn();
		render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 100));

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(authData);
	});

	test("auto-completes silently when login resolves without calling onReady", async () => {
		// Mirrors the real behavior of auth.login() when loadAuth() returns a
		// valid cached session: it short-circuits and resolves without invoking
		// the onReady callback, so no browser prompt should appear.
		const authData = fakeAuth();
		vi.spyOn(auth, "login").mockImplementation((onLog) => {
			onLog(`Already logged in as ${authData.user.email}`);
			return Promise.resolve(authData);
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("Already logged in as test@example.com");
		expect(output).not.toContain("Press Enter to open the browser");
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(authData);
	});

	test("retries on Enter after a failure and succeeds on the second attempt", async () => {
		const authData = fakeAuth();
		const loginSpy = vi
			.spyOn(auth, "login")
			.mockImplementationOnce(() => Promise.reject(new Error("transient")))
			.mockImplementationOnce(() => Promise.resolve(authData));
		loginSpy.mockClear();

		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 100));
		expect(lastFrame() ?? "").toContain("Login failed: transient");
		expect(onDone).not.toHaveBeenCalled();

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));

		expect(loginSpy).toHaveBeenCalledTimes(2);
		expect(onDone).toHaveBeenCalledWith(authData);
	});

	test("clears the previous error and logs when retrying", async () => {
		vi.spyOn(auth, "login")
			.mockImplementationOnce((onLog) => {
				onLog("first attempt log");
				return Promise.reject(new Error("boom"));
			})
			.mockImplementationOnce((_onLog, onReady) => {
				onReady(() => {}, "https://sso.test/authorize?x=1", () => null);
				return new Promise(() => {});
			});

		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));
		expect(lastFrame() ?? "").toContain("first attempt log");
		expect(lastFrame() ?? "").toContain("Login failed: boom");

		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		const after = lastFrame() ?? "";
		expect(after).not.toContain("first attempt log");
		expect(after).not.toContain("Login failed: boom");
		expect(after).not.toContain("Press Enter to retry");
	});
});
