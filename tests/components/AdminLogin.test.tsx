import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AdminLogin } from "@/components/AdminLogin.js";
import * as auth from "@/lib/auth.js";
import * as skillhub from "@/lib/skillhub.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string) =>
	s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

async function waitFor(predicate: () => boolean, tries = 100): Promise<void> {
	for (let i = 0; i < tries; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("waitFor: condition not met within timeout");
}

// Type `text` into the active field, then press Enter. Waits for the input UI
// to mount (so Ink's listener is attached) before the single write — writing
// repeatedly would accumulate ("root" → "rootroot"), so we write once and wait
// for the frame to reflect it.
async function typeField(
	stdin: { write: (s: string) => void },
	lastFrame: () => string | undefined,
	text: string,
	seen: () => boolean,
): Promise<void> {
	await waitFor(() =>
		stripAnsi(lastFrame() ?? "").includes("ADMIN/SUPERADMIN"),
	);
	await new Promise((r) => setTimeout(r, 20));
	stdin.write(text);
	await waitFor(seen);
	stdin.write("\r");
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("AdminLogin", () => {
	test("signs in, stores the cookie, and reports the user", async () => {
		const signIn = vi.spyOn(skillhub, "skillhubSignIn").mockResolvedValue({
			cookie: "skill-hub-session=tok",
			user: { id: "1", username: "root", role: "SUPERADMIN" },
		});
		const save = vi
			.spyOn(auth, "saveSkillhubCookie")
			.mockImplementation(() => {});
		const onDone = vi.fn();

		const { stdin, lastFrame } = render(<AdminLogin onDone={onDone} />);

		await typeField(stdin, lastFrame, "root", () =>
			stripAnsi(lastFrame() ?? "").includes("root"),
		);
		await typeField(stdin, lastFrame, "hunter2", () =>
			stripAnsi(lastFrame() ?? "").includes("•••••••"),
		);

		await waitFor(() => onDone.mock.calls.length > 0);
		expect(signIn).toHaveBeenCalledWith("root", "hunter2");
		expect(save).toHaveBeenCalledWith("skill-hub-session=tok");
		expect(onDone).toHaveBeenCalledWith({
			id: "1",
			username: "root",
			role: "SUPERADMIN",
		});
	});

	test("masks the password (never renders it in plaintext)", async () => {
		vi.spyOn(skillhub, "skillhubSignIn").mockResolvedValue({
			cookie: "skill-hub-session=tok",
			user: { id: "1", username: "root", role: "ADMIN" },
		});
		vi.spyOn(auth, "saveSkillhubCookie").mockImplementation(() => {});

		const { stdin, lastFrame } = render(<AdminLogin onDone={vi.fn()} />);

		await typeField(stdin, lastFrame, "root", () =>
			stripAnsi(lastFrame() ?? "").includes("root"),
		);
		await waitFor(() => {
			stdin.write("secret");
			return stripAnsi(lastFrame() ?? "").includes("••••••");
		});
		expect(stripAnsi(lastFrame() ?? "")).not.toContain("secret");
	});

	test("shows the server error and a retry hint on a failed sign-in", async () => {
		vi.spyOn(skillhub, "skillhubSignIn").mockRejectedValue(
			new Error("Invalid username or password"),
		);
		const save = vi
			.spyOn(auth, "saveSkillhubCookie")
			.mockImplementation(() => {});
		const onDone = vi.fn();

		const { stdin, lastFrame } = render(<AdminLogin onDone={onDone} />);

		await typeField(stdin, lastFrame, "root", () =>
			stripAnsi(lastFrame() ?? "").includes("root"),
		);
		await typeField(stdin, lastFrame, "bad", () =>
			stripAnsi(lastFrame() ?? "").includes("•••"),
		);

		await waitFor(() =>
			stripAnsi(lastFrame() ?? "").includes("Invalid username or password"),
		);
		expect(stripAnsi(lastFrame() ?? "")).toContain("press Enter to retry");
		expect(save).not.toHaveBeenCalled();
		expect(onDone).not.toHaveBeenCalled();
	});
});
