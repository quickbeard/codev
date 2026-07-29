import * as child_process from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DoctorApp } from "@/DoctorApp.js";
import * as auth from "@/lib/auth.js";
import * as backend from "@/lib/backend.js";
import {
	DOCTOR_PROXY_ENV,
	doctorOutcome,
	resetDoctorOutcome,
} from "@/lib/doctor.js";
import * as log from "@/lib/log.js";
import { PROXY_APPLIED_ENV } from "@/lib/proxy.js";
import * as reexec from "@/lib/reexec.js";
import * as tls from "@/lib/tls.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});

const PROXY_VARS = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
	"NODE_USE_SYSTEM_CA",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	DOCTOR_PROXY_ENV,
	PROXY_APPLIED_ENV,
];

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

// Mirrors the shape normalization in InstallApp.test.tsx: production uses
// (file, args, opts, cb) on POSIX and a single command string on Windows.
function stubExecFile(
	handler: (
		file: string,
		args: string[],
	) => { error?: Error | null; stdout?: string; stderr?: string },
) {
	vi.mocked(child_process.execFile).mockImplementation(((
		...callArgs: unknown[]
	) => {
		const cb = callArgs[callArgs.length - 1] as ExecCb;
		const first = callArgs[0] as string;
		const second = callArgs[1];
		let file: string;
		let args: string[];
		if (Array.isArray(second)) {
			file = first;
			args = second as string[];
		} else {
			const tokens = first.split(/\s+/).filter(Boolean);
			file = tokens[0] ?? "";
			args = tokens.slice(1);
		}
		const r = handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
}

let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "codev-doctorapp-test-"));
	vi.stubEnv("HOME", tempHome);
	vi.stubEnv("USERPROFILE", tempHome);
	for (const name of PROXY_VARS) vi.stubEnv(name, "");
	resetDoctorOutcome();

	// Every npm probe answers plausibly by default; individual tests override.
	stubExecFile((file, args) => {
		if (file !== "npm") return { stdout: "" };
		if (args[0] === "-v") return { stdout: "10.9.0" };
		if (args[0] === "config") return { stdout: "undefined" };
		if (args[0] === "ping") return { stdout: "ok" };
		if (args[0] === "view") return { stdout: "0.4.5" };
		return { stdout: "" };
	});
	// The OS trust store read is slow on Windows and machine-dependent
	// everywhere; pin it so the row is deterministic.
	vi.spyOn(tls.tlsApi, "supported").mockReturnValue(true);
	vi.spyOn(tls.tlsApi, "getCACertificates").mockReturnValue(["cert"]);
	// Never let a test reach the real network or re-exec the CLI.
	vi.spyOn(log, "loggedFetch").mockResolvedValue(
		new Response("", { status: 200 }),
	);
	vi.spyOn(reexec.spawner, "spawnSync").mockReturnValue(
		// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
		{ status: 0 } as any,
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempHome, { recursive: true, force: true });
});

function fakeAuth(): auth.AuthData {
	return {
		access_token: "access-xyz",
		id_token: "id-xyz",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "u", email: "test@example.com", displayName: "Test" },
	};
}

/** Stub the whole happy path: sign-in, key, config, analysis backend, gateway, LLM. */
function stubHappyPath() {
	vi.spyOn(auth, "login").mockResolvedValue(fakeAuth());
	vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-doctor-123");
	vi.spyOn(backend, "fetchCodevConfig").mockResolvedValue({
		analysisBackendUrl: "https://analysis.example.com",
		analysisBackendAnonKey: "anon",
		gatewayUrl: "https://gateway.example.com",
	});
	vi.spyOn(backend, "fetchAnalysisBackendSession").mockResolvedValue({
		access_token: "sb",
		user: { id: "u", email: "test@example.com" },
	});
	vi.spyOn(backend, "validateApiKey").mockResolvedValue(true);
	vi.spyOn(backend, "fetchModels").mockResolvedValue(["m-alpha", "m-beta"]);
	vi.spyOn(backend, "smokeTestModel").mockResolvedValue(null);
}

// Poll rather than sleep — the flow is a chain of async phases and a fixed
// sleep that passes locally is a Heisenbug on slower CI.
async function waitForFrame(
	frames: string[],
	needle: string,
	maxMs = 5_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		if (frames.join("\n").includes(needle)) {
			await new Promise((r) => setTimeout(r, 30));
			return;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("DoctorApp", () => {
	test("a clean machine reaches the summary and exits 0", async () => {
		stubHappyPath();
		const { frames } = render(<DoctorApp />);

		await waitForFrame(frames, "Everything checks out");
		const output = frames.join("\n");

		// Every group ran, in order.
		expect(output).toContain("Environment");
		expect(output).toContain("Network");
		expect(output).toContain("Signed in as test@example.com");
		expect(output).toContain("LLM access");
		// The LLM completion is the check that proves inference is permitted.
		expect(output).toContain("m-alpha answered a test prompt");
		expect(output).toContain("codevhub install");
		expect(doctorOutcome.exitCode).toBe(0);
	});

	// The run-wide inventories, distinct from the per-check activity lines: they
	// answer "what did this just run on my machine?" and "which hosts do I have
	// to allow-list?" without the reader correlating a dozen rows. `loggedFetch`
	// is stubbed here so no request is ever recorded — the endpoints half is
	// covered in tests/components/ActivityLog.test.tsx.
	test("the run inventories every command it spawned, above the verdict", async () => {
		stubHappyPath();
		const { frames } = render(<DoctorApp />);

		await waitForFrame(frames, "Commands run");
		// The last frame that still has the section: the app exits ~1s after the
		// terminal phase, and joining every frame would interleave the growing
		// check list with the finished one and make ordering meaningless.
		const frame = frames.filter((f) => f.includes("Commands run")).at(-1) ?? "";

		expect(frame).toContain("Activity");
		// Every npm probe the run made, whichever check made it. The exact,
		// ordered inventory is pinned in tests/lib/doctor-commands.test.ts.
		expect(frame).toContain("✓ npm -v");
		expect(frame).toContain("✓ npm config get registry");
		expect(frame).toContain("✓ npm view codev-ai version");

		// Evidence sits above the verdict: the summary line, the numbered next
		// steps and the report path are what has to survive on screen.
		expect(frame.indexOf("Commands run")).toBeLessThan(frame.indexOf("Result"));
	});

	test("a failing LLM completion fails the run and explains itself", async () => {
		stubHappyPath();
		vi.spyOn(backend, "smokeTestModel").mockResolvedValue(
			"Gateway rejected a test request for m-alpha (HTTP 403): over budget",
		);
		const { frames } = render(<DoctorApp />);

		await waitForFrame(frames, "check(s) failed");
		const output = frames.join("\n");

		expect(output).toContain("What happened");
		expect(output).toContain("Likely cause");
		expect(output).toContain("What to do");
		expect(output).toContain("over budget");
		expect(doctorOutcome.exitCode).toBe(1);
	});

	// The point of the whole command: a network failure must never surface as
	// a bare `fetch failed`.
	test("a network failure renders the full diagnosis, not `fetch failed`", async () => {
		const err = new TypeError("fetch failed");
		(err as Error & { cause?: unknown }).cause = Object.assign(
			new Error("getaddrinfo ENOTFOUND netmind.example.com"),
			{ code: "ENOTFOUND", hostname: "netmind.example.com" },
		);
		vi.spyOn(log, "loggedFetch").mockRejectedValue(err);
		stubHappyPath();

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "Could not resolve");
		const output = frames.join("\n");

		expect(output).toContain("Could not resolve netmind.example.com");
		expect(output).toContain("What to do");
		// The raw chain is still shown — hiding it would cost support the detail.
		expect(output).toContain("code ENOTFOUND");
	});

	test("a network failure offers the proxy prompt", async () => {
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
					code: "ECONNREFUSED",
				}),
			}),
		);
		stubHappyPath();

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "Proxy (host:port)");
		expect(frames.join("\n")).toContain("Configure a proxy");
	});

	test("submitting a proxy records the retry for index.tsx to run", async () => {
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
					code: "ECONNREFUSED",
				}),
			}),
		);
		stubHappyPath();

		const { frames, stdin } = render(<DoctorApp />);
		await waitForFrame(frames, "Proxy (host:port)");
		// Give ProxyPrompt's useInput handler a render to register on before
		// typing — a keystroke that lands first is simply dropped.
		await new Promise((r) => setTimeout(r, 80));
		stdin.write("10.0.0.1:8080");
		await new Promise((r) => setTimeout(r, 50));
		stdin.write("\r");
		await new Promise((r) => setTimeout(r, 100));

		// The app must NOT spawn the retry itself — Ink still owns the TTY.
		expect(doctorOutcome.retryWithProxy).toEqual({
			http: "http://10.0.0.1:8080",
			https: "http://10.0.0.1:8080",
		});
		expect(reexec.spawner.spawnSync).not.toHaveBeenCalled();
	});

	test("an empty proxy answer skips the retry and continues to the summary", async () => {
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
					code: "ECONNREFUSED",
				}),
			}),
		);
		stubHappyPath();

		const { frames, stdin } = render(<DoctorApp />);
		await waitForFrame(frames, "Proxy (host:port)");
		stdin.write("\r");

		await waitForFrame(frames, "check(s) failed");
		expect(doctorOutcome.retryWithProxy).toBeNull();
		// It still gets far enough to hand back setup instructions.
		expect(frames.join("\n")).toContain("Next steps");
	});

	// Offering the prompt again in the retry child would loop the user forever.
	test("the retry child is not offered the proxy prompt again", async () => {
		vi.stubEnv(DOCTOR_PROXY_ENV, "1");
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
					code: "ECONNREFUSED",
				}),
			}),
		);
		stubHappyPath();

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "check(s) failed");
		expect(frames.join("\n")).not.toContain("Proxy (host:port)");
	});

	// A wrong proxy address is one of the likeliest reasons the checks failed,
	// so the prompt must still be offered — an earlier revision suppressed it
	// here and left exactly that user with no way to try a different one.
	test("still prompts when a proxy is already configured, naming the current one", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
					code: "ECONNREFUSED",
				}),
			}),
		);
		stubHappyPath();

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "Proxy (host:port)");
		const output = frames.join("\n");
		// The question shifts from "do you need a proxy?" to "is this one wrong?".
		expect(output).toContain("even though a proxy is configured");
		expect(output).toContain("http://10.0.0.1:8080");
		expect(output).toContain("Enter to keep the current one");
		// The examples belong on BOTH variants — someone correcting a wrong proxy
		// needs the syntax just as much as someone entering their first one.
		expect(output).toContain("Examples:");
		expect(output).toContain("user:pass@");
	});

	test("offers concrete examples of what to type", async () => {
		vi.spyOn(log, "loggedFetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
					code: "ECONNREFUSED",
				}),
			}),
		);
		stubHappyPath();

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "Proxy (host:port)");
		const output = frames.join("\n");
		expect(output).toContain("Examples:");
		// Each example answers a question "host:port" alone leaves open.
		expect(output).toContain("10.60.129.1:3128");
		expect(output).toContain("proxy.corp.vn:8080");
		expect(output).toContain("user:pass@");
		expect(output).toContain("http:// is assumed");
	});

	// Login must not park the run on a retry prompt — the summary is the value.
	test("a sign-in failure is recorded and the run still reaches the summary", async () => {
		vi.spyOn(auth, "login").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(
					new Error("getaddrinfo ENOTFOUND sso.example.com"),
					{
						code: "ENOTFOUND",
						hostname: "sso.example.com",
					},
				),
			}),
		);

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "check(s) failed");
		const output = frames.join("\n");

		expect(output).toContain("Could not resolve sso.example.com");
		// Downstream checks report themselves as skipped, which shows how far the
		// flow got rather than silently vanishing.
		expect(output).toContain("Skipped");
		expect(output).not.toContain("Press Enter to retry");
		expect(doctorOutcome.exitCode).toBe(1);
	});

	test("environment warnings do not fail the run", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://10.0.0.1:8080");
		vi.stubEnv("NODE_USE_ENV_PROXY", "1");
		vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
		stubHappyPath();

		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "warning(s)");
		expect(frames.join("\n")).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
		expect(doctorOutcome.exitCode).toBe(0);
	});

	test("reports what is already installed on this machine", async () => {
		stubHappyPath();
		const { frames } = render(<DoctorApp />);
		await waitForFrame(frames, "This machine");
		expect(frames.join("\n")).toContain("This machine");
	});
});
