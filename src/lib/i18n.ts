import { en, type MessageKey } from "@/lib/locales/en.js";
import { vi } from "@/lib/locales/vi.js";

export type { MessageKey };

export type Locale = "en" | "vi";

const CATALOGS: Record<Locale, Record<string, string>> = { en, vi };
const SUPPORTED = Object.keys(CATALOGS) as Locale[];
const DEFAULT_LOCALE: Locale = "en";

/**
 * The base of a `<key>_one` / `<key>_other` pair. Only bases that declare BOTH
 * halves qualify, so `tCount` can never be handed a key whose singular form was
 * never written.
 */
// Written as a generic helper rather than inlined: a conditional type only
// distributes over a *naked type parameter*, so `MessageKey extends ...` would
// test the whole union at once and collapse to `never`.
type PluralBase<K> = K extends `${infer Base}_other`
	? `${Base}_one` extends MessageKey
		? Base
		: never
	: never;

export type PluralKey = PluralBase<MessageKey>;

export type Params = Record<string, string | number>;

/**
 * Resolved once per process and memoized. Deliberately lazy rather than an
 * `initLocale()` the dispatcher calls: ESM imports are evaluated before
 * `index.tsx`'s body runs, so module-level strings (and the Node-version gate at
 * the top of index.tsx, which fires before argv is even destructured) would
 * always read the locale before an explicit init could set it. Every input here
 * is an environment variable — fixed before the process starts — so resolving on
 * first use has no ordering hazard at all.
 *
 * It is also why there is no `--lang` flag: argv would put that hazard back.
 */
let cached: Locale | null = null;

/**
 * "vi_VN.UTF-8" / "vi-VN" / "VI" / "vi@quot" all mean Vietnamese. Anything we
 * don't ship (including "C" and "POSIX") returns null so the caller falls
 * through to the next source rather than pinning an unsupported locale.
 */
function normalize(raw: string | undefined): Locale | null {
	if (!raw) return null;
	const tag = raw.trim().toLowerCase().split(".")[0]?.split("@")[0] ?? "";
	const primary = tag.split(/[-_]/)[0] ?? "";
	return SUPPORTED.includes(primary as Locale) ? (primary as Locale) : null;
}

function resolve(): Locale {
	const env = process.env;
	// Each spelling is normalized independently. A plain `??` chain over the raw
	// values would let an exported-but-empty LC_ALL mask a perfectly good LANG —
	// the same trap lib/proxy.ts documents for HTTP_PROXY/http_proxy.
	const fromEnv =
		normalize(env.CODEV_LANG) ??
		normalize(env.LC_ALL) ??
		normalize(env.LC_MESSAGES) ??
		normalize(env.LANG);
	if (fromEnv) return fromEnv;
	// The Windows path: LANG is normally unset there, but Node's ICU reports the
	// OS locale here. Guarded because a broken ICU build must not take the CLI
	// down over a display-language lookup.
	try {
		return (
			normalize(Intl.DateTimeFormat().resolvedOptions().locale) ??
			DEFAULT_LOCALE
		);
	} catch {
		return DEFAULT_LOCALE;
	}
}

export function currentLocale(): Locale {
	if (cached === null) cached = resolve();
	return cached;
}

/**
 * Drops the memoized locale so the next lookup re-reads the environment.
 * Tests only — pair it with `vi.stubEnv("CODEV_LANG", …)`. Mirrors the existing
 * `resetLogging()` / `resetModelLimitsCache()` / `resetSystemCaCertsCache()`
 * hooks.
 */
export function resetLocaleCache(): void {
	cached = null;
}

/** Replaces `{name}` placeholders. An unsupplied name is left verbatim. */
function interpolate(template: string, params?: Params): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = params[name];
		return value === undefined ? match : String(value);
	});
}

/**
 * Look up a message in the active locale.
 *
 * Falls back to English, then to the key itself. `Record<MessageKey, string>` on
 * each non-English catalog makes a missing key a compile error, so neither
 * fallback should ever fire — they exist so that a bad catalog degrades to
 * readable output instead of a blank frame or a throw.
 */
export function t(key: MessageKey, params?: Params): string {
	const template = CATALOGS[currentLocale()][key] ?? en[key] ?? key;
	return interpolate(template, params);
}

/**
 * Count-aware lookup, selecting between `<key>_one` and `<key>_other`. `count`
 * is added to the interpolation params automatically.
 *
 * Deliberately not a plural-rules engine: English is the only locale we ship
 * that inflects at all, and Vietnamese has no plural form, so both catalogs are
 * fully served by a two-way split. A locale with a genuine `few`/`many` category
 * would be the moment to reach for `Intl.PluralRules`.
 */
export function tCount(key: PluralKey, count: number, params?: Params): string {
	const suffixed = `${key}${count === 1 ? "_one" : "_other"}` as MessageKey;
	return t(suffixed, { count, ...params });
}

/**
 * Natural-language list join in the active locale: "X", "X and Y",
 * "X, Y, and Z" in English; "X, Y và Z" in Vietnamese.
 *
 * `Intl.ListFormat` is built into Node and its English output is identical to
 * the hand-rolled Oxford-comma joiner this replaces.
 */
export function formatList(items: string[]): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0] ?? "";
	return listFormatter().format(items);
}

/**
 * The same join, split into its items and the separators between them, so a
 * caller can style the items independently — `Confirm` renders each restore
 * command in cyan but the ", and " between them in plain text.
 *
 * Without this a component has to hand-code the separators, which is where the
 * English comma rules were previously baked in.
 */
export function formatListParts(
	items: string[],
): { type: "element" | "literal"; value: string }[] {
	if (items.length === 0) return [];
	if (items.length === 1) {
		return [{ type: "element", value: items[0] ?? "" }];
	}
	return listFormatter().formatToParts(items);
}

function listFormatter(): Intl.ListFormat {
	return new Intl.ListFormat(currentLocale(), {
		style: "long",
		type: "conjunction",
	});
}
