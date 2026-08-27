import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "codev-test-"));
	vi.stubEnv("HOME", tempDir);
	vi.stubEnv("USERPROFILE", tempDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function seedAuthFile(contents: Record<string, unknown>) {
	const dir = join(tempDir, ".codev-hub");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(contents));
}

describe("slugifyProviderName", () => {
	test.each([
		["Acme AI Gateway", "acme-ai-gateway"],
		["My_Gateway 2.0", "my-gateway-2-0"],
		["  Padded  ", "padded"],
		["UPPER", "upper"],
		["--leading-and-trailing--", "leading-and-trailing"],
		["a//b", "a-b"],
	])("%s → %s", async (input, expected) => {
		const { slugifyProviderName } = await import("@/lib/provider.js");
		expect(slugifyProviderName(input)).toBe(expected);
	});

	test("returns '' when nothing usable survives", async () => {
		const { slugifyProviderName } = await import("@/lib/provider.js");
		expect(slugifyProviderName("!!!")).toBe("");
		expect(slugifyProviderName("   ")).toBe("");
	});

	test("caps the id at 32 chars", async () => {
		const { slugifyProviderName } = await import("@/lib/provider.js");
		expect(slugifyProviderName("abcdefghij klmnopqrst uvwxyz01234 5")).toBe(
			"abcdefghij-klmnopqrst-uvwxyz0123",
		);
	});

	test("never leaves a trailing dash after the cap", async () => {
		const { slugifyProviderName } = await import("@/lib/provider.js");
		// The separator lands on the 32nd char, so a bare slice would end in "-".
		expect(slugifyProviderName("abcdefghij klmnopqrst uvwxyz012 34")).toBe(
			"abcdefghij-klmnopqrst-uvwxyz012",
		);
	});

	test("the slug is always a TOML-bare-safe, slash-free key", async () => {
		const { slugifyProviderName } = await import("@/lib/provider.js");
		expect(slugifyProviderName("Acme/AI: Gateway (v2)!")).toMatch(
			/^[a-z0-9-]+$/,
		);
	});
});

describe("providerFromName", () => {
	test("derives the id and keeps the typed name", async () => {
		const { providerFromName } = await import("@/lib/provider.js");
		expect(providerFromName("  Acme AI  ")).toEqual({
			id: "acme-ai",
			name: "Acme AI",
		});
	});

	test("falls back to AI Gateway / ai-gateway for a blank or unusable name", async () => {
		const { providerFromName } = await import("@/lib/provider.js");
		const fallback = { id: "ai-gateway", name: "AI Gateway" };
		expect(providerFromName("")).toEqual(fallback);
		expect(providerFromName("!!!")).toEqual(fallback);
	});
});

describe("resolveProvider", () => {
	test("defaults to AIGW when the credentials carry no provider", async () => {
		const { resolveProvider } = await import("@/lib/provider.js");
		expect(resolveProvider({})).toEqual({ id: "aigw", name: "AIGW" });
	});

	test("uses the credentials' provider when present", async () => {
		const { resolveProvider } = await import("@/lib/provider.js");
		expect(
			resolveProvider({ providerId: "acme-ai", providerName: "Acme AI" }),
		).toEqual({ id: "acme-ai", name: "Acme AI" });
	});

	test("falls back to the id as the display name", async () => {
		const { resolveProvider } = await import("@/lib/provider.js");
		expect(resolveProvider({ providerId: "acme-ai" })).toEqual({
			id: "acme-ai",
			name: "acme-ai",
		});
	});
});

describe("codevProviderIds", () => {
	test("lists the built-ins, including the pre-rename ids", async () => {
		const { codevProviderIds } = await import("@/lib/provider.js");
		expect(codevProviderIds()).toEqual([
			"aigw",
			"ai-gateway",
			"netgate",
			"aigateway",
		]);
	});

	test("puts a saved custom id first", async () => {
		seedAuthFile({ api_key: "sk", provider_id: "acme-ai" });
		const { codevProviderIds } = await import("@/lib/provider.js");
		expect(codevProviderIds()[0]).toBe("acme-ai");
		expect(codevProviderIds()).toContain("aigateway");
	});

	test("does not duplicate a saved id that is already a built-in", async () => {
		seedAuthFile({ api_key: "sk", provider_id: "aigw" });
		const { codevProviderIds } = await import("@/lib/provider.js");
		expect(codevProviderIds()).toEqual([
			"aigw",
			"ai-gateway",
			"netgate",
			"aigateway",
		]);
	});

	test("still recognizes the pre-rename netgate id", async () => {
		seedAuthFile({ api_key: "sk", provider_id: "netgate" });
		const { codevProviderIds } = await import("@/lib/provider.js");
		expect(codevProviderIds()).toContain("netgate");
		expect(codevProviderIds()[0]).toBe("aigw");
	});

	test("tolerates a missing auth.json", async () => {
		const { codevProviderIds } = await import("@/lib/provider.js");
		expect(codevProviderIds()).toContain("aigw");
	});
});
