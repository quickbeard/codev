import { describe, expect, test } from "vitest";
import { en } from "@/lib/locales/en.js";
import { vi } from "@/lib/locales/vi.js";

// `Record<MessageKey, string>` already makes a missing key a compile error, so
// these tests cover what the type system cannot see: values that are present but
// wrong. A blank string renders as a blank frame; a mistyped placeholder renders
// as literal `{cout}` in front of the user.
const CATALOGS: [string, Record<string, string>][] = [
	["en", en],
	["vi", vi],
];

/** The `{name}` placeholders a template expects, order-independent. */
function placeholders(template: string): Set<string> {
	return new Set(
		[...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string),
	);
}

describe.each(CATALOGS)("%s catalog", (_name, catalog) => {
	test("has no blank messages", () => {
		const blank = Object.keys(catalog).filter((k) => catalog[k]?.trim() === "");
		expect(blank).toEqual([]);
	});

	test("has no untrimmed keys", () => {
		const bad = Object.keys(catalog).filter((k) => k !== k.trim());
		expect(bad).toEqual([]);
	});
});

describe("catalog parity", () => {
	test("every locale declares exactly the English key set", () => {
		const expected = Object.keys(en).sort();
		for (const [name, catalog] of CATALOGS) {
			expect({ [name]: Object.keys(catalog).sort() }).toEqual({
				[name]: expected,
			});
		}
	});

	test("each key uses the same placeholders in every locale", () => {
		const mismatched: string[] = [];
		for (const key of Object.keys(en)) {
			const expected = placeholders(en[key as keyof typeof en]);
			for (const [name, catalog] of CATALOGS) {
				const actual = placeholders(catalog[key] ?? "");
				if (
					actual.size !== expected.size ||
					[...expected].some((p) => !actual.has(p))
				) {
					mismatched.push(
						`${key} (${name}): expected {${[...expected].join(", ")}}, got {${[...actual].join(", ")}}`,
					);
				}
			}
		}
		expect(mismatched).toEqual([]);
	});

	test("every plural declares both halves", () => {
		const keys = new Set(Object.keys(en));
		const lonely = [...keys]
			.filter((k) => k.endsWith("_one") || k.endsWith("_other"))
			.filter((k) => {
				const base = k.replace(/_(one|other)$/, "");
				return !keys.has(`${base}_one`) || !keys.has(`${base}_other`);
			});
		expect(lonely).toEqual([]);
	});
});
