import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoginApp } from "@/LoginApp.js";
import * as auth from "@/lib/auth.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-xyz",
		id_token: "id-xyz",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

let refreshSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	refreshSpy = vi
		.spyOn(auth, "refreshCodevConfig")
		.mockResolvedValue(undefined);
});

describe("LoginApp", () => {
	test("prints summary line after a successful login", async () => {
		const authData = fakeAuth();
		vi.spyOn(auth, "login").mockImplementation((onLog) => {
			onLog("Already logged in as test@example.com");
			return Promise.resolve(authData);
		});

		const { frames } = render(<LoginApp />);
		await new Promise((r) => setTimeout(r, 200));

		const history = allFrames(frames);
		// <Login>'s completed state renders the green signed-in line.
		expect(history).toContain("✓ Signed in as test@example.com");
	});

	test("refreshes the Supabase config with the new access token", async () => {
		const authData = fakeAuth();
		vi.spyOn(auth, "login").mockResolvedValue(authData);

		render(<LoginApp />);
		await new Promise((r) => setTimeout(r, 100));

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy.mock.calls[0]?.[0]).toBe(authData.access_token);
	});

	test("does not call logout() when force is false", async () => {
		const logoutSpy = vi.spyOn(auth, "logout").mockResolvedValue(true);
		vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());

		render(<LoginApp />);
		await new Promise((r) => setTimeout(r, 100));

		expect(logoutSpy).not.toHaveBeenCalled();
	});

	test("force=true calls logout() before login() runs", async () => {
		const order: string[] = [];
		vi.spyOn(auth, "logout").mockImplementation(() => {
			order.push("logout");
			return Promise.resolve(true);
		});
		vi.spyOn(auth, "login").mockImplementation(() => {
			order.push("login");
			return Promise.resolve(fakeAuth());
		});

		render(<LoginApp force={true} />);
		// Windows CI runners are slow enough that a fixed 100ms wait can land
		// after logout() resolved but before React re-rendered and Login's
		// effect fired login(). Poll until both have happened instead.
		await vi.waitFor(() => expect(order).toEqual(["logout", "login"]));
	});

	test("force=true shows the signing-out step before mounting Login", async () => {
		// Hold logout open so we can observe the preparing phase. Otherwise
		// logout would resolve on the next microtask and we'd already be past
		// it by the time we read lastFrame.
		let releaseLogout: () => void = () => {};
		vi.spyOn(auth, "logout").mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					releaseLogout = () => resolve(true);
				}),
		);
		const loginSpy = vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());

		const { lastFrame } = render(<LoginApp force={true} />);
		await vi.waitFor(() =>
			expect(lastFrame() ?? "").toContain("Signing out previous session"),
		);
		expect(loginSpy).not.toHaveBeenCalled();

		releaseLogout();
		await vi.waitFor(() => expect(loginSpy).toHaveBeenCalled());
	});
});
