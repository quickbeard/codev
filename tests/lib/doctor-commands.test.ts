import * as child_process from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	ACCOUNT_CHECKS,
	buildDoctorReport,
	type Check,
	ENVIRONMENT_CHECKS,
	LLM_CHECKS,
	NETWORK_CHECKS,
	PREFLIGHT_CHECKS,
	recordedCommands,
	recordedRequests,
	rerunDoctorWithProxy,
	runChecks,
	STATE_CHECKS,
	startCommandRecording,
} from "@/lib/doctor.js";
import * as log from "@/lib/log.js";
import { loggedFetch, recordRequests, requestLog } from "@/lib/log.js";
import { commandLog } from "@/lib/npm.js";
import * as proxy from "@/lib/proxy.js";
import * as reexec from "@/lib/reexec.js";
import * as tls from "@/lib/tls.js";

/**
 * The complete inventory of every child process `codevhub doctor` spawns.
 *
 * `doctor` is a diagnostic tool people run on locked-down machines, often while
 * on a call with IT — "what is this thing actually running?" is a fair question
 * and needs an answer that isn't "read the source". These tests are that
 * answer, and they fail the moment a command is added, removed or reworded, so
 * the list cannot quietly drift.
 *
 * Spying at the `execFile` boundary rather than on `lib/npm.ts#execAsync` is
 * deliberate: helpers inside npm.ts call `execAsync` through their module-local
 * binding, which a spy on the export cannot intercept. An earlier draft of this
 * file used that spy and reported the `state` group as spawning nothing, when
 * it was in fact shelling out four times.
 */

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
];

let spawned: string[];

beforeEach(() => {
	spawned = [];
	commandLog.enabled = false;
	commandLog.entries = [];
	for (const name of PROXY_VARS) vi.stubEnv(name, "");
	proxy.resetProxyState();

	vi.mocked(child_process.execFile).mockImplementation(((
		...callArgs: unknown[]
	) => {
		const cb = callArgs[callArgs.length - 1] as (
			e: Error | null,
			stdout: string,
			stderr: string,
		) => void;
		const first = callArgs[0] as string;
		const second = callArgs[1];
		// POSIX passes (file, args, opts, cb); win32 passes one command string.
		spawned.push(
			Array.isArray(second)
				? `${first} ${(second as string[]).join(" ")}`.trim()
				: first,
		);
		setImmediate(() => cb(null, "/tmp/npm-prefix", ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);

	// Nothing below should reach the network or the real OS trust store.
	vi.spyOn(log, "loggedFetch").mockResolvedValue(
		new Response("", { status: 200 }),
	);
	vi.spyOn(tls.tlsApi, "supported").mockReturnValue(true);
	vi.spyOn(tls.tlsApi, "getCACertificates").mockReturnValue(["cert"]);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function commandsFor(checks: Check[]): Promise<string[]> {
	// Reset so each call reports only its own group — several tests below run
	// more than one group and would otherwise see the running total.
	spawned = [];
	await runChecks(checks, {
		accessToken: "token",
		apiKey: "key",
		gatewayUrl: "https://gateway.example.com",
		models: ["m-alpha"],
	});
	return spawned;
}

describe("every command `codevhub doctor` runs", () => {
	// The pre-flight is also embedded at the head of `codevhub install`, where a
	// single `npm config get` (~300ms) would be felt on every run. Zero is the
	// contract, not an accident — see PREFLIGHT_CHECKS in lib/doctor.ts.
	test("pre-flight (also used by install): runs nothing", async () => {
		expect(await commandsFor(PREFLIGHT_CHECKS)).toEqual([]);
	});

	test("environment group: 7 npm probes, all read-only", async () => {
		expect(await commandsFor(ENVIRONMENT_CHECKS)).toEqual([
			"npm -v",
			"npm config get prefix",
			"npm config get registry",
			"npm config get proxy",
			"npm config get https-proxy",
			"npm config get strict-ssl",
			"npm config get cafile",
		]);
	});

	test("network group: a registry ping and a metadata read", async () => {
		expect(await commandsFor(NETWORK_CHECKS)).toEqual([
			"npm ping",
			"npm view codev-ai version",
		]);
	});

	test("account group: pure HTTP, no child processes", async () => {
		expect(await commandsFor(ACCOUNT_CHECKS)).toEqual([]);
	});

	test("llm group: pure HTTP, no child processes", async () => {
		expect(await commandsFor(LLM_CHECKS)).toEqual([]);
	});

	// Regression: this ran `npm root -g` once per agent — four serial spawns for
	// an answer that cannot differ between them.
	test("state group: resolves npm's global root exactly once", async () => {
		expect(await commandsFor(STATE_CHECKS)).toEqual(["npm root -g"]);
	});

	test("a whole run spawns 10 processes, and every one is read-only", async () => {
		const all = [
			...(await commandsFor(ENVIRONMENT_CHECKS)),
			...(await commandsFor(NETWORK_CHECKS)),
			...(await commandsFor(ACCOUNT_CHECKS)),
			...(await commandsFor(LLM_CHECKS)),
			...(await commandsFor(STATE_CHECKS)),
		];
		expect(all).toHaveLength(10);
		// Everything is `npm`, and nothing mutates: no install, uninstall, publish,
		// cache write or config *set*. `doctor` promises to be read-only and this
		// is what enforces it.
		for (const command of all) {
			expect(command).toMatch(/^npm /);
			expect(command).not.toMatch(
				/\b(install|i|add|uninstall|rm|remove|publish|link|update|dedupe)\b/,
			);
			expect(command).not.toMatch(/config set/);
		}
	});
});

// Knowing the list is only useful if the user is shown it. The inventory above
// is the contract; this is the part that gets it in front of them.
describe("the commands are recorded and reported back", () => {
	test("recording is off until doctor asks for it", async () => {
		commandLog.enabled = false;
		commandLog.entries = [];
		await commandsFor(ENVIRONMENT_CHECKS);
		// Other commands (`update`, the upload daemon) share execAsync and must
		// not accumulate an unbounded buffer.
		expect(commandLog.entries).toEqual([]);
	});

	test("captures every command, in order, with timing and outcome", async () => {
		startCommandRecording();
		await commandsFor(NETWORK_CHECKS);
		const recorded = recordedCommands();
		expect(recorded.map((c) => c.command)).toEqual([
			"npm ping",
			"npm view codev-ai version",
		]);
		for (const c of recorded) {
			expect(c.ok).toBe(true);
			expect(typeof c.durationMs).toBe("number");
		}
	});

	// It catches `npm root -g`, which is spawned by a helper *inside* npm.ts —
	// the case an external wrapper around execAsync cannot see.
	test("captures commands spawned from inside npm.ts itself", async () => {
		startCommandRecording();
		await commandsFor(STATE_CHECKS);
		expect(recordedCommands().map((c) => c.command)).toEqual(["npm root -g"]);
	});

	test("a failing command is recorded as failed, not dropped", async () => {
		vi.mocked(child_process.execFile).mockImplementation(((
			...callArgs: unknown[]
		) => {
			const cb = callArgs[callArgs.length - 1] as (
				e: Error | null,
				o: string,
				s: string,
			) => void;
			setImmediate(() => cb(new Error("boom"), "", "npm ERR!"));
			return {} as unknown as child_process.ChildProcess;
		}) as unknown as typeof child_process.execFile);

		startCommandRecording();
		await commandsFor(NETWORK_CHECKS);
		expect(recordedCommands()[0]?.ok).toBe(false);
	});

	test("a new run starts from an empty list", async () => {
		startCommandRecording();
		await commandsFor(NETWORK_CHECKS);
		expect(recordedCommands()).toHaveLength(2);
		startCommandRecording();
		expect(recordedCommands()).toEqual([]);
	});

	test("the report file carries them too", async () => {
		startCommandRecording();
		await commandsFor(ENVIRONMENT_CHECKS);
		const report = buildDoctorReport([], "2026-07-29T00:00:00.000Z");
		expect(report.commands.map((c) => c.command)).toEqual([
			"npm -v",
			"npm config get prefix",
			"npm config get registry",
			"npm config get proxy",
			"npm config get https-proxy",
			"npm config get strict-ssl",
			"npm config get cafile",
		]);
	});
});

// The one command doctor runs that is NOT npm, and the only one that starts a
// new CoDev process. Its argv and environment are asserted in doctor.test.ts;
// this states the shape alongside the rest of the inventory.
describe("the one non-npm command: the proxy retry", () => {
	test("runs node on this CLI again with `doctor`", () => {
		const spawn = vi
			.spyOn(reexec.spawner, "spawnSync")
			// biome-ignore lint/suspicious/noExplicitAny: minimal SpawnSyncReturns stub
			.mockReturnValue({ status: 0 } as any);

		rerunDoctorWithProxy(
			{ http: "http://10.0.0.1:8080", https: "http://10.0.0.1:8080" },
			[],
		);

		const [file, argv] = spawn.mock.calls[0] ?? [];
		expect([file, ...(argv as string[])]).toEqual([
			process.execPath,
			...process.execArgv,
			process.argv[1],
			"doctor",
		]);
	});

	test("is not spawned unless the user supplies a proxy", async () => {
		const spawn = vi.spyOn(reexec.spawner, "spawnSync");
		await commandsFor(NETWORK_CHECKS);
		expect(spawn).not.toHaveBeenCalled();
	});
});

/**
 * The npm list alone was only half the answer. `doctor`'s connection tests —
 * backend, the analysis backend, the gateway — are HTTP, never touch `execAsync`, and so
 * appeared nowhere. On a corporate network they are the *more* useful half:
 * the endpoints are what IT needs in order to allow-list them.
 *
 * These stub global `fetch`, not `loggedFetch`: the recorder lives inside
 * `loggedFetch`, so stubbing that export bypasses the very code under test.
 */
describe("the endpoints doctor contacted", () => {
	beforeEach(() => {
		// Undo the module-level loggedFetch stub so the real one — and its
		// recorder — actually runs.
		vi.restoreAllMocks();
		recordRequests();
	});

	function stubFetch(status = 200) {
		return vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("", { status }));
	}

	test("records method, URL, status and duration", async () => {
		stubFetch(200);
		await loggedFetch("probe", "https://api.example.com/v1/models", {
			method: "GET",
		});
		const [r] = recordedRequests();
		expect(r?.method).toBe("GET");
		expect(r?.url).toBe("https://api.example.com/v1/models");
		expect(r?.status).toBe(200);
		expect(typeof r?.durationMs).toBe("number");
	});

	// OAuth codes, signed-URL signatures and access tokens all live in query
	// strings, and none of it helps a user see which endpoint was contacted.
	test("drops the query string", async () => {
		stubFetch(200);
		await loggedFetch(
			"probe",
			"https://api.example.com/callback?code=SUPERSECRET&state=abc",
		);
		const [r] = recordedRequests();
		expect(r?.url).toBe("https://api.example.com/callback");
		expect(r?.url).not.toContain("SUPERSECRET");
	});

	// A 401 means the endpoint answered — reachability succeeded even though
	// the request did not. It is recorded, so the UI can score it on
	// "did anything come back" rather than on 2xx.
	test("records a non-2xx response with its status", async () => {
		stubFetch(401);
		await loggedFetch("probe", "https://api.example.com/config", {
			method: "POST",
		});
		const [r] = recordedRequests();
		expect(r?.status).toBe(401);
		expect(r?.ok).toBe(false);
	});

	test("a request that never got a response has a null status", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("getaddrinfo ENOTFOUND x"), {
					code: "ENOTFOUND",
				}),
			}),
		);
		await expect(
			loggedFetch("probe", "https://api.example.com/x"),
		).rejects.toThrow();
		const [r] = recordedRequests();
		expect(r?.status).toBeNull();
		expect(r?.ok).toBe(false);
	});

	test("recording is off until doctor asks for it", async () => {
		requestLog.enabled = false;
		requestLog.entries = [];
		stubFetch(200);
		await loggedFetch("probe", "https://api.example.com/x");
		expect(requestLog.entries).toEqual([]);
	});

	test("the report file carries the endpoints too", async () => {
		stubFetch(200);
		await loggedFetch("probe", "https://api.example.com/x");
		const report = buildDoctorReport([], "2026-07-29T00:00:00.000Z");
		expect(report.requests.map((r) => r.url)).toEqual([
			"https://api.example.com/x",
		]);
	});
});

/**
 * Attribution: each check shows what it ran, under its own row, rather than in
 * a separate list the reader has to correlate back to a step.
 */
describe("each check reports what it ran", () => {
	test("a check that shells out lists its commands", async () => {
		startCommandRecording();
		const check = ENVIRONMENT_CHECKS.find((c) => c.key === "npm-available");
		const [o] = await runChecks([check as Check], {});
		expect(o?.activity?.map((a) => a.detail)).toEqual(["npm -v"]);
		expect(o?.activity?.[0]?.kind).toBe("command");
	});

	// npm-registry fans out five `npm config get` concurrently; all five belong
	// to it, which is what the before/after slice around a sequential run buys.
	test("a check that fans out keeps all of its work on one row", async () => {
		startCommandRecording();
		const check = ENVIRONMENT_CHECKS.find((c) => c.key === "npm-registry");
		const [o] = await runChecks([check as Check], {});
		expect(o?.activity).toHaveLength(5);
		for (const a of o?.activity ?? []) {
			expect(a.detail).toMatch(/^npm config get /);
		}
	});

	test("work is never attributed to the wrong check", async () => {
		startCommandRecording();
		const outcomes = await runChecks(
			[
				ENVIRONMENT_CHECKS.find((c) => c.key === "node-version") as Check,
				ENVIRONMENT_CHECKS.find((c) => c.key === "npm-available") as Check,
			],
			{},
		);
		// node-version is pure logic and must claim nothing.
		expect(outcomes[0]?.activity).toBeUndefined();
		expect(outcomes[1]?.activity?.map((a) => a.detail)).toEqual(["npm -v"]);
	});

	test("a pure-logic check carries no activity at all", async () => {
		startCommandRecording();
		const outcomes = await runChecks(PREFLIGHT_CHECKS, {});
		// undefined rather than [], so the renderer has one falsy thing to test
		// and the report file stays free of empty arrays.
		for (const o of outcomes) expect(o.activity).toBeUndefined();
	});
});
