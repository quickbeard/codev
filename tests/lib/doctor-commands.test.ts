import * as child_process from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	ACCOUNT_CHECKS,
	type Check,
	ENVIRONMENT_CHECKS,
	LLM_CHECKS,
	NETWORK_CHECKS,
	PREFLIGHT_CHECKS,
	rerunDoctorWithProxy,
	runChecks,
	STATE_CHECKS,
} from "@/lib/doctor.js";
import * as log from "@/lib/log.js";
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
