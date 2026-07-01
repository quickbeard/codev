import { describe, expect, test } from "vitest";
import { stripControlChars } from "@/lib/sanitize.js";

// Build control characters at runtime so the source stays plain ASCII.
const ESC = String.fromCharCode(0x1b); // escape (starts ANSI sequences)
const NUL = String.fromCharCode(0x00);
const BEL = String.fromCharCode(0x07);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85); // a C1 control

describe("stripControlChars", () => {
	test("neutralises ANSI escape sequences (drops the ESC byte)", () => {
		expect(stripControlChars(`${ESC}[31mred${ESC}[0m`)).toBe("[31mred[0m");
	});

	test("drops C0, DEL, and C1 control characters", () => {
		expect(stripControlChars(`a${NUL}b${BEL}c${CR}${LF}`)).toBe("abc");
		expect(stripControlChars(`del${DEL}here`)).toBe("delhere");
		expect(stripControlChars(`nel${NEL}here`)).toBe("nelhere");
	});

	test("keeps printable ASCII and multibyte unicode intact", () => {
		expect(stripControlChars("pg-tuner@1.2.0 by viettel")).toBe(
			"pg-tuner@1.2.0 by viettel",
		);
		expect(stripControlChars("café — 日本語 ✅")).toBe("café — 日本語 ✅");
	});
});
