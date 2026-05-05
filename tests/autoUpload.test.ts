import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAuthenticatedForUpload, parseAutoUploadFlag } from "@/autoUpload.js";

describe("parseAutoUploadFlag", () => {
	const originalEnv = process.env.CODEV_NO_AUTO_UPLOAD;

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.CODEV_NO_AUTO_UPLOAD;
		else process.env.CODEV_NO_AUTO_UPLOAD = originalEnv;
	});

	test("auto-uploads by default and forwards args verbatim", () => {
		delete process.env.CODEV_NO_AUTO_UPLOAD;
		const result = parseAutoUploadFlag(["resume", "--model", "sonnet"]);
		expect(result.autoUpload).toBe(true);
		expect(result.agentArgs).toEqual(["resume", "--model", "sonnet"]);
	});

	test("strips --no-upload before forwarding to the agent", () => {
		delete process.env.CODEV_NO_AUTO_UPLOAD;
		const result = parseAutoUploadFlag([
			"resume",
			"--no-upload",
			"--model",
			"sonnet",
		]);
		expect(result.autoUpload).toBe(false);
		expect(result.agentArgs).toEqual(["resume", "--model", "sonnet"]);
	});

	test("disables auto-upload when CODEV_NO_AUTO_UPLOAD=1", () => {
		process.env.CODEV_NO_AUTO_UPLOAD = "1";
		const result = parseAutoUploadFlag(["--model", "sonnet"]);
		expect(result.autoUpload).toBe(false);
		expect(result.agentArgs).toEqual(["--model", "sonnet"]);
	});

	test("ignores other CODEV_NO_AUTO_UPLOAD values", () => {
		process.env.CODEV_NO_AUTO_UPLOAD = "0";
		const result = parseAutoUploadFlag([]);
		expect(result.autoUpload).toBe(true);
	});

	test("handles --no-upload at the very start", () => {
		delete process.env.CODEV_NO_AUTO_UPLOAD;
		const result = parseAutoUploadFlag(["--no-upload"]);
		expect(result.autoUpload).toBe(false);
		expect(result.agentArgs).toEqual([]);
	});
});

describe("isAuthenticatedForUpload", () => {
	let tempHome: string;
	let homedirSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tempHome = mkdtempSync(join(tmpdir(), "codev-auto-upload-"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
	});

	afterEach(() => {
		homedirSpy.mockRestore();
		rmSync(tempHome, { recursive: true, force: true });
	});

	test("returns false when no auth file exists", () => {
		expect(isAuthenticatedForUpload()).toBe(false);
	});

	test("returns false when auth has expired", () => {
		mkdirSync(join(tempHome, ".codev"), { recursive: true });
		writeFileSync(
			join(tempHome, ".codev", "auth.json"),
			JSON.stringify({
				access_token: "t",
				id_token: "t",
				expires_at: Date.now() - 1000,
				user: { sub: "u", email: "u@example.com", displayName: "User" },
			}),
		);
		expect(isAuthenticatedForUpload()).toBe(false);
	});

	test("returns true when a valid auth file exists", () => {
		mkdirSync(join(tempHome, ".codev"), { recursive: true });
		writeFileSync(
			join(tempHome, ".codev", "auth.json"),
			JSON.stringify({
				access_token: "t",
				id_token: "t",
				expires_at: Date.now() + 60_000,
				user: { sub: "u", email: "u@example.com", displayName: "User" },
			}),
		);
		expect(isAuthenticatedForUpload()).toBe(true);
	});
});
