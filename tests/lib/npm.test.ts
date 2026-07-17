import * as child_process from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	claudeNativeBinaryMissing,
	detectInstalledViaNpm,
	installAndVerify,
	installPackage,
	isPackageInstalledGlobally,
	npmGlobalRoot,
	verifyInstall,
} from "@/lib/npm.js";
import {
	ensureSystemCaBundle,
	resetSystemCaCertsCache,
	systemCaBundlePath,
	tlsApi,
} from "@/lib/tls.js";

// ESM module namespaces are frozen — vi.spyOn can't redefine `execFile` /
// `existsSync` directly. We replace them up-front with vi.fn() via vi.mock()
// (which vitest hoists above all imports), then per-test we call
// `vi.mocked(...).mockImplementation(...)` to wire behavior.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn() };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		statSync: vi.fn(actual.statSync),
	};
});

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

interface ExecCall {
	file: string;
	args: string[];
}

interface StubOptions {
	handler: (
		file: string,
		args: string[],
	) => {
		error?: Error | null;
		stdout?: string;
		stderr?: string;
	};
}

// Normalize execFile call shapes: production code uses `(file, args, opts,
// cb)` on POSIX and the single-string `(cmdString, opts, cb)` form on Windows
// (the latter to avoid Node 22's DEP0190 — passing args with shell:true is
// deprecated). Tests assert on (file, args) regardless of platform.
function normalizeExecFileCall(callArgs: unknown[]): {
	file: string;
	args: string[];
	cb: ExecCb;
} {
	const cb = callArgs[callArgs.length - 1] as ExecCb;
	const first = callArgs[0] as string;
	const second = callArgs[1];
	if (Array.isArray(second)) {
		return { file: first, args: second as string[], cb };
	}
	const tokens = first.split(/\s+/).filter(Boolean);
	return { file: tokens[0] ?? "", args: tokens.slice(1), cb };
}

function stubExecFile(opts: StubOptions): ExecCall[] {
	const calls: ExecCall[] = [];
	vi.mocked(child_process.execFile).mockImplementation(((
		...callArgs: unknown[]
	) => {
		const { file, args, cb } = normalizeExecFileCall(callArgs);
		calls.push({ file, args });
		const r = opts.handler(file, args);
		setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
		return {} as unknown as child_process.ChildProcess;
	}) as unknown as typeof child_process.execFile);
	return calls;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(child_process.execFile).mockReset();
	vi.mocked(fs.existsSync).mockReset();
	vi.mocked(fs.statSync).mockReset();
});

// `npm install -g` is a separate process with its own trust store: Node ignores
// the OS store, so behind an intercepting proxy npm fails exactly like our own
// fetch did. These pin the recovery.
describe("execAsync CA recovery", () => {
	const PEM_A = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n";
	const PEM_B = "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n";
	let tempDir: string;

	// Captures the env each child was spawned with, which the shared stub drops.
	function stubExecFileCapturingEnv(
		handler: (n: number) => {
			error?: Error | null;
			stdout?: string;
			stderr?: string;
		},
	): NodeJS.ProcessEnv[] {
		const envs: NodeJS.ProcessEnv[] = [];
		vi.mocked(child_process.execFile).mockImplementation(((
			...callArgs: unknown[]
		) => {
			const cb = callArgs[callArgs.length - 1] as ExecCb;
			const opts = callArgs.find(
				(a): a is { env?: NodeJS.ProcessEnv } =>
					typeof a === "object" && a !== null && !Array.isArray(a),
			);
			envs.push(opts?.env ?? {});
			const r = handler(envs.length);
			setImmediate(() => cb(r.error ?? null, r.stdout ?? "", r.stderr ?? ""));
			return {} as unknown as child_process.ChildProcess;
		}) as unknown as typeof child_process.execFile);
		return envs;
	}

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "codev-npm-ca-"));
		vi.stubEnv("HOME", tempDir);
		vi.stubEnv("USERPROFILE", tempDir);
		vi.stubEnv("NODE_EXTRA_CA_CERTS", undefined);
		// node:fs is module-mocked here, and the shared afterEach resets the impl.
		// childCaEnv must see real disk: a stub that claims the bundle exists
		// before it's written makes execAsync think the child was already helped
		// and skip the retry.
		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(fs.existsSync).mockImplementation(actualFs.existsSync);
		vi.spyOn(tlsApi, "getCACertificates").mockImplementation((type) =>
			type === "system" ? [PEM_B] : [PEM_A],
		);
	});

	afterEach(() => {
		resetSystemCaCertsCache();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("retries a cert-failed install with the CA bundle", async () => {
		const envs = stubExecFileCapturingEnv((n) =>
			n === 1
				? {
						error: new Error("Command failed"),
						stderr: "npm error code SELF_SIGNED_CERT_IN_CHAIN",
					}
				: { stdout: "ok" },
		);

		const err = await installPackage("some-pkg");

		expect(err).toBeNull();
		expect(envs.length).toBe(2);
		// First attempt is unaided — nothing had detected interception yet.
		expect(envs[0]?.NODE_EXTRA_CA_CERTS).toBeUndefined();
		expect(envs[1]?.NODE_EXTRA_CA_CERTS).toBe(systemCaBundlePath());
	});

	test("hands the bundle to the first attempt once it exists", async () => {
		ensureSystemCaBundle();
		const envs = stubExecFileCapturingEnv(() => ({ stdout: "ok" }));

		await installPackage("some-pkg");

		expect(envs.length).toBe(1);
		expect(envs[0]?.NODE_EXTRA_CA_CERTS).toBe(systemCaBundlePath());
	});

	test("does not retry an ordinary npm failure", async () => {
		const envs = stubExecFileCapturingEnv(() => ({
			error: new Error("Command failed"),
			stderr: "npm error 404 Not Found - GET https://registry/some-pkg",
		}));

		const err = await installPackage("some-pkg");

		expect(err).toContain("404");
		expect(envs.length).toBe(1);
	});

	// Retrying with the same env would just be slower — the CA isn't in the OS
	// store either, so nothing changed between attempts.
	test("gives up when there is no bundle to write", async () => {
		vi.spyOn(tlsApi, "getCACertificates").mockReturnValue([]);
		const envs = stubExecFileCapturingEnv(() => ({
			error: new Error("Command failed"),
			stderr: "npm error code SELF_SIGNED_CERT_IN_CHAIN",
		}));

		await installPackage("some-pkg");

		expect(envs.length).toBe(1);
	});
});

describe("npm.ts", () => {
	describe("installPackage", () => {
		test("runs npm i -g with hardening flags", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "ok" }) });
			const err = await installPackage("some-pkg");
			expect(err).toBeNull();
			expect(calls.length).toBe(1);
			expect(calls[0]?.file).toBe("npm");
			// --include=optional / --ignore-scripts=false override hostile global
			// .npmrc settings so the native binary's optional dep + postinstall run.
			expect(calls[0]?.args).toEqual([
				"i",
				"-g",
				"some-pkg",
				"--include=optional",
				"--ignore-scripts=false",
			]);
		});

		test("returns stderr on failure", async () => {
			stubExecFile({
				handler: () => ({
					error: new Error("exit 1"),
					stderr: "npm: permission denied\n",
				}),
			});
			const err = await installPackage("some-pkg");
			expect(err).toBe("npm: permission denied");
		});

		test("falls back to error message if stderr empty", async () => {
			stubExecFile({
				handler: () => ({ error: new Error("spawn npm ENOENT") }),
			});
			const err = await installPackage("some-pkg");
			expect(err).toBe("spawn npm ENOENT");
		});
	});

	describe("npmGlobalRoot", () => {
		test("returns trimmed stdout on success", async () => {
			stubExecFile({
				handler: () => ({ stdout: "/usr/local/lib/node_modules\n" }),
			});
			const root = await npmGlobalRoot();
			expect(root).toBe("/usr/local/lib/node_modules");
		});

		test("returns null on error", async () => {
			stubExecFile({ handler: () => ({ error: new Error("boom") }) });
			const root = await npmGlobalRoot();
			expect(root).toBeNull();
		});

		test("returns null for empty output", async () => {
			stubExecFile({ handler: () => ({ stdout: "   \n" }) });
			const root = await npmGlobalRoot();
			expect(root).toBeNull();
		});
	});

	describe("verifyInstall", () => {
		test("invokes the CLI binary with --version", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "1.0.0" }) });
			const err = await verifyInstall("claude-code");
			expect(err).toBeNull();
			expect(calls[0]?.file).toBe("claude");
			expect(calls[0]?.args).toEqual(["--version"]);
		});

		test("uses 'opencode' binary for opencode tool", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "1.0.0" }) });
			await verifyInstall("opencode");
			expect(calls[0]?.file).toBe("opencode");
		});

		test("returns an error string on failure", async () => {
			stubExecFile({
				handler: () => ({
					error: new Error("spawn claude ENOENT"),
					stderr: "",
				}),
			});
			const err = await verifyInstall("claude-code");
			expect(err).toBe("spawn claude ENOENT");
		});
	});

	describe("installAndVerify", () => {
		test("returns null on happy path", async () => {
			stubExecFile({ handler: () => ({ stdout: "ok" }) });
			const err = await installAndVerify("opencode");
			expect(err).toBeNull();
		});

		test("claude-code: installs the @stable dist-tag", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "1.0.0" }) });
			const err = await installAndVerify("claude-code");
			expect(err).toBeNull();
			const installCall = calls.find(
				(c) => c.file === "npm" && c.args[0] === "i",
			);
			expect(installCall?.args).toContain("@anthropic-ai/claude-code@stable");
		});

		test("opencode: installs the bare package with no dist-tag", async () => {
			const calls = stubExecFile({ handler: () => ({ stdout: "1.0.0" }) });
			await installAndVerify("opencode");
			const installCall = calls.find(
				(c) => c.file === "npm" && c.args[0] === "i",
			);
			expect(installCall?.args).toContain("opencode-ai");
			expect(installCall?.args.some((a) => a.includes("@stable"))).toBe(false);
		});

		test("returns install error when npm install fails", async () => {
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "i") {
						return { error: new Error("x"), stderr: "disk full" };
					}
					return { stdout: "1.0.0" };
				},
			});
			const err = await installAndVerify("opencode");
			expect(err).toBe("disk full");
		});

		test("opencode: returns verify error if CLI fails post-install", async () => {
			stubExecFile({
				handler: (file) => {
					if (file === "npm") return { stdout: "ok" };
					// opencode --version fails
					return { error: new Error("nope"), stderr: "cannot run" };
				},
			});
			const err = await installAndVerify("opencode");
			expect(err).toContain("installed but 'opencode' fails");
			expect(err).toContain("cannot run");
		});

		test("claude-code: runs postinstall recovery and re-verifies", async () => {
			let claudeCalls = 0;
			const existsSpy = vi.mocked(fs.existsSync).mockImplementation(() => true);
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "i") return { stdout: "ok" };
					if (file === "npm" && args[0] === "root") {
						return { stdout: "/fake/root" };
					}
					if (file === "claude") {
						claudeCalls += 1;
						// First call fails; second (after postinstall) succeeds.
						if (claudeCalls === 1) {
							return { error: new Error("missing binary"), stderr: "oops" };
						}
						return { stdout: "1.0.0" };
					}
					if (file === "node") return { stdout: "postinstall ok" };
					return { stdout: "" };
				},
			});
			const err = await installAndVerify("claude-code");
			expect(err).toBeNull();
			expect(claudeCalls).toBe(2);
			existsSpy.mockRestore();
		});

		test("claude-code: recovers via reinstall when postinstall can't place the binary", async () => {
			// Models the omit=optional case: install.cjs exits 0 without placing
			// the binary (the optional dep isn't on disk), so the post-postinstall
			// verify still fails; the forced reinstall re-fetches the optional dep
			// and the next verify succeeds.
			let claudeCalls = 0;
			let npmInstalls = 0;
			const existsSpy = vi.mocked(fs.existsSync).mockImplementation(() => true);
			const calls = stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "i") {
						npmInstalls += 1;
						return { stdout: "ok" };
					}
					if (file === "npm" && args[0] === "root") {
						return { stdout: "/fake/root" };
					}
					if (file === "node") return { stdout: "install.cjs exited 0" };
					if (file === "claude") {
						claudeCalls += 1;
						// firstVerify + after-postinstall both fail; after the
						// reinstall (3rd call) it succeeds.
						if (claudeCalls <= 2) {
							return { error: new Error("missing binary"), stderr: "oops" };
						}
						return { stdout: "1.0.0" };
					}
					return { stdout: "" };
				},
			});
			const err = await installAndVerify("claude-code");
			expect(err).toBeNull();
			expect(claudeCalls).toBe(3);
			// Two global installs: the primary one + the recovery reinstall.
			expect(npmInstalls).toBe(2);
			// The recovery reinstall ran after the install.cjs postinstall attempt.
			const nodeIdx = calls.findIndex((c) => c.file === "node");
			const reinstallIdx = calls.findIndex(
				(c, i) => i > nodeIdx && c.file === "npm" && c.args[0] === "i",
			);
			expect(reinstallIdx).toBeGreaterThan(nodeIdx);
			existsSpy.mockRestore();
		});

		test("claude-code: reports failure when postinstall and reinstall both fail to fix", async () => {
			const existsSpy = vi.mocked(fs.existsSync).mockImplementation(() => true);
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "i") return { stdout: "ok" };
					if (file === "npm" && args[0] === "root") {
						return { stdout: "/fake/root" };
					}
					if (file === "claude") {
						return { error: new Error("missing binary"), stderr: "oops" };
					}
					if (file === "node") {
						return { error: new Error("x"), stderr: "postinstall failed" };
					}
					return { stdout: "" };
				},
			});
			const err = await installAndVerify("claude-code");
			expect(err).toContain(
				"still fails after recovery (postinstall + reinstall)",
			);
			existsSpy.mockRestore();
		});

		test("claude-code: surfaces a failed recovery reinstall", async () => {
			// install.cjs fails AND the forced reinstall fails — the error should
			// name the reinstall failure rather than claim success.
			let npmInstalls = 0;
			const existsSpy = vi.mocked(fs.existsSync).mockImplementation(() => true);
			stubExecFile({
				handler: (file, args) => {
					if (file === "npm" && args[0] === "i") {
						npmInstalls += 1;
						// Primary install succeeds; the recovery reinstall fails.
						if (npmInstalls === 1) return { stdout: "ok" };
						return { error: new Error("x"), stderr: "registry offline" };
					}
					if (file === "npm" && args[0] === "root") {
						return { stdout: "/fake/root" };
					}
					if (file === "claude") {
						return { error: new Error("missing binary"), stderr: "oops" };
					}
					if (file === "node") {
						return { error: new Error("x"), stderr: "postinstall failed" };
					}
					return { stdout: "" };
				},
			});
			const err = await installAndVerify("claude-code");
			expect(err).toContain("recovery reinstall failed: registry offline");
			existsSpy.mockRestore();
		});

		describe("codex windows recovery", () => {
			function withWin32<T>(
				arch: "x64" | "arm64",
				fn: () => Promise<T> | T,
			): Promise<T> {
				const origPlatform = process.platform;
				const origArch = process.arch;
				Object.defineProperty(process, "platform", {
					value: "win32",
					configurable: true,
				});
				Object.defineProperty(process, "arch", {
					value: arch,
					configurable: true,
				});
				return Promise.resolve()
					.then(fn)
					.finally(() => {
						Object.defineProperty(process, "platform", {
							value: origPlatform,
							configurable: true,
						});
						Object.defineProperty(process, "arch", {
							value: origArch,
							configurable: true,
						});
					});
			}

			test("codex: returns null when first install + verify succeed (no recovery)", async () => {
				await withWin32("x64", async () => {
					const calls = stubExecFile({ handler: () => ({ stdout: "ok" }) });
					const err = await installAndVerify("codex");
					expect(err).toBeNull();
					// 1x install + 1x verify, no recovery
					expect(calls.length).toBe(2);
					expect(calls.some((c) => c.args.includes("view"))).toBe(false);
				});
			});

			test("codex: runs Windows recovery on x64 and re-verifies", async () => {
				await withWin32("x64", async () => {
					let codexCalls = 0;
					const calls = stubExecFile({
						handler: (file, args) => {
							if (
								file === "npm" &&
								args[0] === "i" &&
								args[2] === "@openai/codex"
							) {
								return { stdout: "ok" };
							}
							if (file === "npm" && args[0] === "view") {
								return { stdout: "0.125.0\n" };
							}
							if (
								file === "npm" &&
								args[0] === "i" &&
								args.some((a) => a.startsWith("@openai/codex@"))
							) {
								return { stdout: "ok" };
							}
							if (file === "codex") {
								codexCalls += 1;
								if (codexCalls === 1) {
									return {
										error: new Error("missing native"),
										stderr: "Missing optional dependency",
									};
								}
								return { stdout: "0.125.0" };
							}
							return { stdout: "" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toBeNull();
					expect(codexCalls).toBe(2);

					const recoveryCall = calls.find(
						(c) =>
							c.file === "npm" &&
							c.args[0] === "i" &&
							c.args.some((a) => a.startsWith("@openai/codex@")),
					);
					expect(recoveryCall).toBeDefined();
					expect(recoveryCall?.args).toEqual([
						"i",
						"-g",
						"@openai/codex@0.125.0",
						"@openai/codex-win32-x64@npm:@openai/codex@0.125.0-win32-x64",
					]);
				});
			});

			test("codex: targets win32-arm64 alias on arm64 hosts", async () => {
				await withWin32("arm64", async () => {
					let codexCalls = 0;
					const calls = stubExecFile({
						handler: (file, args) => {
							if (file === "npm" && args[0] === "view") {
								return { stdout: "0.125.0" };
							}
							if (file === "codex") {
								codexCalls += 1;
								if (codexCalls === 1) {
									return { error: new Error("missing"), stderr: "" };
								}
								return { stdout: "0.125.0" };
							}
							return { stdout: "ok" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toBeNull();

					const recoveryCall = calls.find(
						(c) =>
							c.file === "npm" &&
							c.args[0] === "i" &&
							c.args.some((a) => a.includes("win32-arm64")),
					);
					expect(recoveryCall?.args).toContain(
						"@openai/codex-win32-arm64@npm:@openai/codex@0.125.0-win32-arm64",
					);
				});
			});

			test("codex: surfaces recovery failure when npm view errors", async () => {
				await withWin32("x64", async () => {
					stubExecFile({
						handler: (file, args) => {
							if (file === "npm" && args[0] === "i") {
								return { stdout: "ok" };
							}
							if (file === "npm" && args[0] === "view") {
								return {
									error: new Error("offline"),
									stderr: "ENOTFOUND registry.npmjs.org",
								};
							}
							if (file === "codex") {
								return { error: new Error("missing"), stderr: "missing" };
							}
							return { stdout: "" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toContain("Windows recovery failed");
					expect(err).toContain("npm view @openai/codex version failed");
				});
			});

			test("codex: surfaces verify failure that persists after recovery", async () => {
				await withWin32("x64", async () => {
					stubExecFile({
						handler: (file, args) => {
							if (file === "npm" && args[0] === "view") {
								return { stdout: "0.125.0" };
							}
							if (file === "codex") {
								return { error: new Error("still broken"), stderr: "still" };
							}
							return { stdout: "ok" };
						},
					});

					const err = await installAndVerify("codex");
					expect(err).toContain(
						"installed but 'codex' still fails after Windows recovery",
					);
				});
			});

			test("codex: on non-Windows, verify failure does not trigger recovery", async () => {
				const origPlatform = process.platform;
				Object.defineProperty(process, "platform", {
					value: "linux",
					configurable: true,
				});
				try {
					const calls = stubExecFile({
						handler: (file) => {
							if (file === "codex") {
								return { error: new Error("missing"), stderr: "broken" };
							}
							return { stdout: "ok" };
						},
					});
					const err = await installAndVerify("codex");
					expect(err).toContain("installed but 'codex' fails");
					expect(calls.some((c) => c.args.includes("view"))).toBe(false);
				} finally {
					Object.defineProperty(process, "platform", {
						value: origPlatform,
						configurable: true,
					});
				}
			});
		});
	});

	describe("claudeNativeBinaryMissing", () => {
		const binPath = join(
			"/fake/root",
			"@anthropic-ai",
			"claude-code",
			"bin",
			"claude.exe",
		);

		test("true when the placeholder stub (<4KB) is still in place", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const statSpy = vi
				.mocked(fs.statSync)
				.mockImplementation(
					(p: fs.PathLike) =>
						(String(p) === binPath ? { size: 1234 } : { size: 0 }) as fs.Stats,
				);
			expect(await claudeNativeBinaryMissing()).toBe(true);
			statSpy.mockRestore();
		});

		test("false when the real native binary is in place", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const statSpy = vi
				.mocked(fs.statSync)
				.mockImplementation(() => ({ size: 213_000_000 }) as fs.Stats);
			expect(await claudeNativeBinaryMissing()).toBe(false);
			statSpy.mockRestore();
		});

		test("false (stay quiet) when the binary path can't be stat'd", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const statSpy = vi.mocked(fs.statSync).mockImplementation(() => {
				throw new Error("ENOENT");
			});
			expect(await claudeNativeBinaryMissing()).toBe(false);
			statSpy.mockRestore();
		});

		test("false (stay quiet) when npm root -g fails", async () => {
			stubExecFile({ handler: () => ({ error: new Error("boom") }) });
			expect(await claudeNativeBinaryMissing()).toBe(false);
		});
	});

	describe("isPackageInstalledGlobally", () => {
		test("returns true when the package dir exists under npm root", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const existsSpy = vi
				.mocked(fs.existsSync)
				.mockImplementation(
					(p: fs.PathLike) =>
						String(p) === join("/fake/root", "@colbymchenry", "codegraph"),
				);
			expect(await isPackageInstalledGlobally("@colbymchenry/codegraph")).toBe(
				true,
			);
			existsSpy.mockRestore();
		});

		test("returns false when the package dir is missing", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const existsSpy = vi
				.mocked(fs.existsSync)
				.mockImplementation(() => false);
			expect(await isPackageInstalledGlobally("@colbymchenry/codegraph")).toBe(
				false,
			);
			existsSpy.mockRestore();
		});

		test("returns false when npm root resolution fails", async () => {
			stubExecFile({ handler: () => ({ error: new Error("boom") }) });
			expect(await isPackageInstalledGlobally("some-pkg")).toBe(false);
		});
	});

	describe("detectInstalledViaNpm", () => {
		test("returns true when package dir exists under npm root", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const existsSpy = vi
				.mocked(fs.existsSync)
				.mockImplementation(
					(p: fs.PathLike) =>
						String(p) === join("/fake/root", "@anthropic-ai", "claude-code"),
				);
			const got = await detectInstalledViaNpm("claude-code");
			expect(got).toBe(true);
			existsSpy.mockRestore();
		});

		test("returns false when package dir missing", async () => {
			stubExecFile({ handler: () => ({ stdout: "/fake/root" }) });
			const existsSpy = vi
				.mocked(fs.existsSync)
				.mockImplementation(() => false);
			const got = await detectInstalledViaNpm("opencode");
			expect(got).toBe(false);
			existsSpy.mockRestore();
		});

		test("returns false when npm root resolution fails", async () => {
			stubExecFile({ handler: () => ({ error: new Error("boom") }) });
			const got = await detectInstalledViaNpm("opencode");
			expect(got).toBe(false);
		});
	});
});
