import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { YesNo } from "@/components/YesNo.js";

afterEach(cleanup);

function tick(ms = 20): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("YesNo", () => {
	test("renders [Y/n] when defaultAnswer is yes", () => {
		const { lastFrame } = render(
			<YesNo defaultAnswer="yes" onAnswer={() => {}} />,
		);
		expect(lastFrame() ?? "").toContain("[Y/n]");
	});

	test("renders [y/N] when defaultAnswer is no", () => {
		const { lastFrame } = render(
			<YesNo defaultAnswer="no" onAnswer={() => {}} />,
		);
		expect(lastFrame() ?? "").toContain("[y/N]");
	});

	test("empty Enter resolves to default (yes)", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="yes" onAnswer={onAnswer} />);
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(true);
	});

	test("empty Enter resolves to default (no)", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="no" onAnswer={onAnswer} />);
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(false);
	});

	test("'y' + Enter proceeds regardless of default", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="no" onAnswer={onAnswer} />);
		stdin.write("y");
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(true);
	});

	test("'yes' + Enter proceeds (multi-char, only first char matters)", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="no" onAnswer={onAnswer} />);
		stdin.write("yes");
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(true);
	});

	test("'n' + Enter aborts regardless of default", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="yes" onAnswer={onAnswer} />);
		stdin.write("n");
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(false);
	});

	test("gibberish (non-y prefix) aborts — apt parity", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="yes" onAnswer={onAnswer} />);
		stdin.write("maybe");
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(false);
	});

	test("'Y' (uppercase) proceeds", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="no" onAnswer={onAnswer} />);
		stdin.write("Y");
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(true);
	});

	test("backspace edits the buffer", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="yes" onAnswer={onAnswer} />);
		// Type "ny", backspace once, leaves "n" — should abort.
		stdin.write("n");
		await tick();
		stdin.write("y");
		await tick();
		stdin.write("\x7f"); // DEL — treated as backspace by Ink
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledWith(false);
	});

	test("does not fire when readOnly", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(
			<YesNo defaultAnswer="yes" onAnswer={onAnswer} readOnly />,
		);
		stdin.write("y\r");
		await tick();
		expect(onAnswer).not.toHaveBeenCalled();
	});

	test("fires only once even if Enter is pressed twice", async () => {
		const onAnswer = vi.fn();
		const { stdin } = render(<YesNo defaultAnswer="yes" onAnswer={onAnswer} />);
		stdin.write("\r");
		await tick();
		stdin.write("\r");
		await tick();
		expect(onAnswer).toHaveBeenCalledTimes(1);
	});

	test("renders the typed buffer back to the user", async () => {
		const { stdin, lastFrame } = render(
			<YesNo defaultAnswer="yes" onAnswer={() => {}} />,
		);
		stdin.write("ye");
		await tick();
		expect(lastFrame() ?? "").toContain("ye");
	});
});
