import { afterEach, describe, expect, test, vi } from "vitest";
import { clipboard } from "@/lib/clipboard.js";

const ESC = "\x1b";
const BEL = "\x07";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("clipboard.copy", () => {
	test("writes a base64 OSC 52 sequence to stdout", () => {
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		clipboard.copy("hello");

		const expected = `${ESC}]52;c;${Buffer.from("hello").toString("base64")}${BEL}`;
		expect(writes).toEqual([expected]);
	});

	test("round-trips arbitrary text through base64", () => {
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const url = "https://sso.test/authorize?x=1&y=2";
		clipboard.copy(url);

		const payload = writes[0]?.slice(`${ESC}]52;c;`.length, -1) ?? "";
		expect(Buffer.from(payload, "base64").toString("utf-8")).toBe(url);
	});
});
