import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import * as auth from "@/lib/auth.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) =>
	s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

// Mirrors how LoginApp/SetupApp/ModelApp mount <Login> — inside a Step's
// bordered, padded box. The manual URL relies on that geometry to break itself
// back out to column 0, so URL-rendering assertions must use this wrapper.
function renderInFrame(onDone: () => void) {
	return render(
		<Box padding={1}>
			<Frame tag="CoDev">
				<Step active title={loginTitle()}>
					<Login onDone={onDone} />
				</Step>
			</Frame>
		</Box>,
	);
}

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
			onReady(
				() => {},
				"https://sso.test/authorize?x=1",
				() => null,
			);
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

	test("shows the fallback URL as soon as it is ready, before Enter is pressed", async () => {
		const url = "https://sso.test/authorize?x=1";
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(
				() => {},
				url,
				() => null,
			);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		// Render inside the Step frame so the URL's column-0 break-out (negative
		// margin) lands correctly, same as the after-Enter fallback test below.
		const { lastFrame } = renderInFrame(onDone);

		await new Promise((r) => setTimeout(r, 50));

		// A no-browser user can copy the URL right away — it no longer hides
		// behind the browser-open Enter.
		expect(lastFrame() ?? "").toContain(url);
	});

	test("shows the authorize URL as a manual fallback after Enter is pressed", async () => {
		const url = "https://sso.test/authorize?x=1";
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(
				() => {},
				url,
				() => null,
			);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { stdin, lastFrame } = renderInFrame(onDone);

		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 50));

		const output = lastFrame() ?? "";
		expect(output).toContain("copy this URL to sign in");
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
				onReady(
					() => {},
					"https://sso.test/authorize?x=1",
					() => null,
				);
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

	test("shows the paste-back prompt as soon as the URL is ready", async () => {
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(
				() => {},
				"https://sso.test/authorize?x=1",
				() => null,
			);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));

		// The paste-back affordance is offered up front, so a no-browser user
		// never has to press Enter into a browser that will never open.
		const output = lastFrame() ?? "";
		expect(output).toContain("remote or headless");
		expect(output).toContain("Press Enter to submit");
	});

	test("completes paste-back without opening the browser first", async () => {
		const authData = fakeAuth();
		const openBrowserFn = vi.fn();
		const submit = vi.fn((_pasted: string) => null);
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			return new Promise<auth.AuthData>((resolve) => {
				onReady(openBrowserFn, "https://sso.test/authorize?x=1", (pasted) => {
					const err = submit(pasted);
					if (!err) resolve(authData);
					return err;
				});
			});
		});

		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));
		// No Enter to open the browser — paste straight away. Re-write until the
		// field shows the value, in case Ink's input listener attaches a beat late.
		const pasted = "http://127.0.0.1:5000/callback?code=abc&state=xyz";
		for (let i = 0; i < 50 && !(lastFrame() ?? "").includes("code=abc"); i++) {
			stdin.write(pasted);
			await new Promise((r) => setTimeout(r, 20));
		}
		stdin.write("\r"); // a non-empty field means Enter submits, not open-browser
		await new Promise((r) => setTimeout(r, 50));

		expect(submit).toHaveBeenCalledWith(
			expect.stringContaining("code=abc&state=xyz"),
		);
		// The browser was never opened — the whole point of the no-browser path.
		expect(openBrowserFn).not.toHaveBeenCalled();
		expect(onDone).toHaveBeenCalledWith(authData);
	});

	test("completes via manual paste-back of the callback URL", async () => {
		const authData = fakeAuth();
		const submit = vi.fn((_pasted: string) => null);
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			return new Promise<auth.AuthData>((resolve) => {
				onReady(
					() => {},
					"https://sso.test/authorize?x=1",
					(pasted) => {
						const err = submit(pasted);
						if (!err) resolve(authData);
						return err;
					},
				);
			});
		});

		const onDone = vi.fn();
		const { stdin } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r"); // open browser → reveals the paste field
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("http://127.0.0.1:5000/callback?code=abc&state=xyz");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r"); // submit the pasted URL
		await new Promise((r) => setTimeout(r, 50));

		expect(submit).toHaveBeenCalledWith(
			expect.stringContaining("code=abc&state=xyz"),
		);
		expect(onDone).toHaveBeenCalledWith(authData);
	});

	test("shows an inline paste error and recovers on re-submit", async () => {
		const authData = fakeAuth();
		let calls = 0;
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			return new Promise<auth.AuthData>((resolve) => {
				onReady(
					() => {},
					"https://sso.test/authorize?x=1",
					() => {
						calls += 1;
						if (calls === 1) return "State mismatch — use the latest URL.";
						resolve(authData);
						return null;
					},
				);
			});
		});

		const onDone = vi.fn();
		const { stdin, lastFrame } = render(<Login onDone={onDone} />);

		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r"); // open browser → paste field
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("oops");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r"); // first submit → inline error
		await new Promise((r) => setTimeout(r, 50));

		expect(lastFrame() ?? "").toContain("State mismatch");
		expect(onDone).not.toHaveBeenCalled();

		stdin.write("\r"); // re-submit → resolves
		await new Promise((r) => setTimeout(r, 50));
		expect(onDone).toHaveBeenCalledWith(authData);
	});

	test("renders the manual URL copy-clean when it wraps (no frame border injected)", async () => {
		const url =
			"https://netmind.viettel.vn/sso-wrapper/authorize?response_type=code&client_id=litellm-test&redirect_uri=http%3A%2F%2F127.0.0.1%3A55806%2Fcallback&scope=openid%20profile%20email%20offline_access&state=279322a5-453f-45ca-ab8a-491acb3c30ea&nonce=23604863-5332-47a6-bc4d-ebd0aba04f55&code_challenge=u8h6Fpso4_e7__Hk7gu_MMF3ymKt--014a02UHxXq30&code_challenge_method=S256";
		vi.spyOn(auth, "login").mockImplementation((_onLog, onReady) => {
			onReady(
				() => {},
				url,
				() => null,
			);
			return new Promise(() => {});
		});

		const onDone = vi.fn();
		const { stdin, lastFrame } = renderInFrame(onDone);

		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r"); // reveal the URL
		await new Promise((r) => setTimeout(r, 50));

		// The long URL wraps across several lines. Dropping ANSI codes and the
		// wrap newlines must leave it intact — i.e. no "│  " gutter (or padding)
		// was injected mid-URL, which is what corrupts a copy-paste. A bare
		// newline at wrap points is fine: new URL() and browser address bars
		// both strip it.
		const joined = stripAnsi(lastFrame() ?? "").replace(/\n/g, "");
		expect(joined).toContain(url);
	});
});
