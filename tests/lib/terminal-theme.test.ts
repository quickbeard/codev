import { describe, expect, test } from "vitest";
import { terminalIsLight } from "@/lib/terminal-theme.js";

describe("terminalIsLight", () => {
	test("returns null when COLORFGBG is unset", () => {
		expect(terminalIsLight({})).toBeNull();
	});

	test("detects a light background (bg 15 / 7)", () => {
		expect(terminalIsLight({ COLORFGBG: "0;15" })).toBe(true);
		expect(terminalIsLight({ COLORFGBG: "0;7" })).toBe(true);
	});

	test("detects a dark background (bg 0 / 8)", () => {
		expect(terminalIsLight({ COLORFGBG: "15;0" })).toBe(false);
		expect(terminalIsLight({ COLORFGBG: "15;8" })).toBe(false);
	});

	test("reads the last field for the rxvt 'fg;default;bg' form", () => {
		expect(terminalIsLight({ COLORFGBG: "0;default;15" })).toBe(true);
		expect(terminalIsLight({ COLORFGBG: "15;default;0" })).toBe(false);
	});

	test("returns null when the background field is not a number", () => {
		expect(terminalIsLight({ COLORFGBG: "0;abc" })).toBeNull();
	});
});
