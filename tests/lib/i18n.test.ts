import { afterEach, describe, expect, test, vi } from "vitest";
import {
	currentLocale,
	formatList,
	type Locale,
	resetLocaleCache,
	t,
	tCount,
} from "@/lib/i18n.js";

// Every test drives resolution through the environment, so each one has to
// start from a clean slate — the resolved locale is memoized for the life of
// the process exactly like lib/log.ts's logger and model-limits' window cache.
afterEach(() => {
	vi.unstubAllEnvs();
	resetLocaleCache();
});

/** Blank every source so a test only sees the vars it sets itself. */
function clearLocaleEnv(): void {
	for (const name of ["CODEV_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		vi.stubEnv(name, "");
	}
	resetLocaleCache();
}

describe("locale resolution", () => {
	test("CODEV_LANG wins over the POSIX locale variables", () => {
		clearLocaleEnv();
		vi.stubEnv("LANG", "en_US.UTF-8");
		vi.stubEnv("CODEV_LANG", "vi");
		resetLocaleCache();
		expect(currentLocale()).toBe("vi");
	});

	test("the POSIX variables are consulted in LC_ALL, LC_MESSAGES, LANG order", () => {
		clearLocaleEnv();
		vi.stubEnv("LANG", "en_US.UTF-8");
		vi.stubEnv("LC_MESSAGES", "en_US.UTF-8");
		vi.stubEnv("LC_ALL", "vi_VN.UTF-8");
		resetLocaleCache();
		expect(currentLocale()).toBe("vi");
	});

	// The trap lib/proxy.ts documents for HTTP_PROXY/http_proxy: a plain `??`
	// chain over raw values only falls through on undefined, so an exported-but-
	// empty variable would mask a perfectly good one further down.
	test("an exported-but-empty variable does not mask a later one", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "");
		vi.stubEnv("LC_ALL", "");
		vi.stubEnv("LANG", "vi_VN.UTF-8");
		resetLocaleCache();
		expect(currentLocale()).toBe("vi");
	});

	test.each([
		"vi",
		"VI",
		"vi_VN",
		"vi-VN",
		"vi_VN.UTF-8",
		"vi@quot",
	])("%s normalizes to vi", (raw) => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", raw);
		resetLocaleCache();
		expect(currentLocale()).toBe("vi");
	});

	test("an unshipped locale falls through instead of pinning itself", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "klingon");
		vi.stubEnv("LANG", "vi_VN.UTF-8");
		resetLocaleCache();
		expect(currentLocale()).toBe("vi");
	});

	test.each([
		"C",
		"POSIX",
		"klingon",
		"de_DE.UTF-8",
	])("%s with no other source resolves to a locale we actually ship", (raw) => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", raw);
		resetLocaleCache();
		// Intl reports the developer's own OS locale as the last source, so the
		// exact value is machine-dependent — what must hold is that an
		// unrecognized name never escapes as the active locale.
		const resolved: Locale = currentLocale();
		expect(["en", "vi"]).toContain(resolved);
	});

	test("the resolved locale is memoized until the cache is reset", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "vi");
		resetLocaleCache();
		expect(currentLocale()).toBe("vi");

		vi.stubEnv("CODEV_LANG", "en");
		expect(currentLocale()).toBe("vi");

		resetLocaleCache();
		expect(currentLocale()).toBe("en");
	});
});

describe("t", () => {
	test("returns the active locale's message", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "vi");
		resetLocaleCache();
		expect(t("common.done")).toBe("Xong!");
	});

	test("interpolates {name} placeholders", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "en");
		resetLocaleCache();
		expect(t("common.file_other", { count: 3 })).toBe("3 files");
	});

	test("leaves a placeholder verbatim when no value is supplied", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "en");
		resetLocaleCache();
		expect(t("common.file_other")).toBe("{count} files");
	});
});

describe("tCount", () => {
	test.each([
		[1, "1 file"],
		[0, "0 files"],
		[2, "2 files"],
	])("English selects on count: %i", (count, expected) => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "en");
		resetLocaleCache();
		expect(tCount("common.file", count)).toBe(expected);
	});

	test("Vietnamese reads the same for either count", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "vi");
		resetLocaleCache();
		expect(tCount("common.file", 1)).toBe("1 tệp");
		expect(tCount("common.file", 5)).toBe("5 tệp");
	});
});

describe("formatList", () => {
	test("English keeps the Oxford comma the hand-rolled joiner produced", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "en");
		resetLocaleCache();
		expect(formatList([])).toBe("");
		expect(formatList(["X"])).toBe("X");
		expect(formatList(["X", "Y"])).toBe("X and Y");
		expect(formatList(["X", "Y", "Z"])).toBe("X, Y, and Z");
	});

	test("Vietnamese joins with và", () => {
		clearLocaleEnv();
		vi.stubEnv("CODEV_LANG", "vi");
		resetLocaleCache();
		expect(formatList(["X", "Y"])).toBe("X và Y");
		expect(formatList(["X", "Y", "Z"])).toBe("X, Y và Z");
	});
});
