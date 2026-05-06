import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SUPABASE_ANON_KEY,
	SUPABASE_PROXY_URL,
	SUPABASE_URL,
} from "@/const.js";

let tempDir: string;
let homedirSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-const-"));
	homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(() => {
	homedirSpy.mockRestore();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeAuthJson(data: Record<string, unknown>) {
	const dir = join(tempDir, ".codev");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(data));
}

const ACCESSORS: ReadonlyArray<
	readonly [name: string, fn: () => string, field: string]
> = [
	["SUPABASE_URL", () => SUPABASE_URL(), "supabase_url"],
	["SUPABASE_ANON_KEY", () => SUPABASE_ANON_KEY(), "supabase_anon_key"],
	["SUPABASE_PROXY_URL", () => SUPABASE_PROXY_URL(), "supabase_proxy_url"],
];

describe("Supabase const accessors", () => {
	test("each returns its field from auth.json", () => {
		writeAuthJson({
			supabase_url: "https://x.supabase.co",
			supabase_anon_key: "anon-x",
			supabase_proxy_url: "https://api.test/api/codev",
		});
		expect(SUPABASE_URL()).toBe("https://x.supabase.co");
		expect(SUPABASE_ANON_KEY()).toBe("anon-x");
		expect(SUPABASE_PROXY_URL()).toBe("https://api.test/api/codev");
	});

	for (const [name, fn, field] of ACCESSORS) {
		test(`${name} hard-fails with field name + install hint when missing`, () => {
			writeAuthJson({});
			let err: unknown;
			try {
				fn();
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(Error);
			const msg = (err as Error).message;
			expect(msg).toContain(field);
			expect(msg).toContain("Run `codev install`");
		});

		test(`${name} hard-fails when auth.json does not exist`, () => {
			expect(fn).toThrow(/Run `codev install`/);
		});

		test(`${name} hard-fails when its field is empty string`, () => {
			writeAuthJson({ [field]: "" });
			expect(fn).toThrow(field);
		});
	}

	test("each accessor reads the live file (no module-load caching)", () => {
		writeAuthJson({
			supabase_url: "https://first.supabase.co",
			supabase_anon_key: "a1",
			supabase_proxy_url: "p1",
		});
		expect(SUPABASE_URL()).toBe("https://first.supabase.co");

		writeAuthJson({
			supabase_url: "https://second.supabase.co",
			supabase_anon_key: "a2",
			supabase_proxy_url: "p2",
		});
		expect(SUPABASE_URL()).toBe("https://second.supabase.co");
	});
});
