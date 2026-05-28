import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TaskList } from "@/components/TaskList.js";

const VERB = {
	infinitive: "install",
	present: "Installing",
	past: "Installed",
};

afterEach(() => {
	cleanup();
});

function allFrames(frames: string[]): string {
	return frames.join("\n");
}

describe("TaskList", () => {
	test("renders a row for each task with the pending label initially", () => {
		const { lastFrame } = render(
			<TaskList
				tasks={[
					{ key: "a", label: "pkg-a", run: () => new Promise(() => {}) },
					{ key: "b", label: "pkg-b", run: () => new Promise(() => {}) },
				]}
				verb={VERB}
				onDone={() => {}}
			/>,
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("pkg-a");
		expect(out).toContain("pkg-b");
	});

	test("shows 'Installing ...' while tasks are running", async () => {
		const { frames } = render(
			<TaskList
				tasks={[{ key: "a", label: "pkg-a", run: () => new Promise(() => {}) }]}
				verb={VERB}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(allFrames(frames)).toContain("Installing pkg-a...");
	});

	test("marks a task as done and reports its key in succeededKeys", async () => {
		const onDone = vi.fn(() => {});
		const { frames } = render(
			<TaskList
				tasks={[{ key: "a", label: "pkg-a", run: () => Promise.resolve(null) }]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(allFrames(frames)).toContain("Installed pkg-a");
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(["a"]);
	});

	test("marks a task as failed and uses the infinitive verb in the error", async () => {
		const onDone = vi.fn(() => {});
		const { frames } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () => Promise.resolve("disk full"),
					},
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(allFrames(frames)).toContain("Failed to install pkg-a: disk full");
		// All tasks hard-failed → empty survivor set.
		expect(onDone).toHaveBeenCalledWith([]);
	});

	test("respects the provided verb (update case)", async () => {
		const { frames } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve(null), 30),
							),
					},
				]}
				verb={{ infinitive: "update", present: "Updating", past: "Updated" }}
				onDone={() => {}}
			/>,
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(allFrames(frames)).toContain("Updating pkg-a...");
		await new Promise((r) => setTimeout(r, 50));
		expect(allFrames(frames)).toContain("Updated pkg-a");
	});

	test("only calls onDone after the final frame shows every task settled", async () => {
		// Regression: onDone used to fire from inside the run-promise chain,
		// so the parent's exit() could unmount before Ink flushed the last
		// "Updated pkg-X"/"Failed to ..." commit to the terminal. onDone must
		// run only after React has committed the terminal status for every row.
		let frameAtDone: string | null = null;
		const captureFrame = vi.fn((_keys: string[]) => {});
		const onDone = (keys: string[]) => {
			frameAtDone = lastFrame() ?? "";
			captureFrame(keys);
		};

		// Mix a fast task, a slow task, and a failing task so the race window
		// is nontrivial. The last settling task is `slow`, which is also the
		// one most likely to be missing from the frame if the race regresses.
		const { lastFrame } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve(null), 5),
							),
					},
					{
						key: "b",
						label: "pkg-b",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve("boom"), 15),
							),
					},
					{
						key: "c",
						label: "pkg-c",
						run: () =>
							new Promise<string | null>((resolve) =>
								setTimeout(() => resolve(null), 40),
							),
					},
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);

		await vi.waitFor(() => expect(captureFrame).toHaveBeenCalled());

		expect(captureFrame).toHaveBeenCalledTimes(1);
		// Survivors are the two ✓ rows; pkg-b hard-failed.
		expect(captureFrame).toHaveBeenCalledWith(["a", "c"]);
		// The frame captured inside onDone must already show the terminal
		// status for every task — no "Installing pkg-X..." rows left over.
		expect(frameAtDone).not.toBeNull();
		expect(frameAtDone ?? "").toContain("Installed pkg-a");
		expect(frameAtDone ?? "").toContain("Failed to install pkg-b: boom");
		expect(frameAtDone ?? "").toContain("Installed pkg-c");
		expect(frameAtDone ?? "").not.toContain("Installing pkg-");
	});

	test("succeededKeys lists only non-failed rows when some hard-fail", async () => {
		// The decision about what "partial failure" means belongs to the
		// parent (e.g. InstallApp advances to Configure with just the
		// survivors). TaskList just reports which keys did not hard-fail.
		const onDone = vi.fn(() => {});
		render(
			<TaskList
				tasks={[
					{ key: "a", label: "pkg-a", run: () => Promise.resolve(null) },
					{ key: "b", label: "pkg-b", run: () => Promise.resolve("boom") },
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(["a"]);
	});

	test("renders a yellow warning row when a task returns `{ warning }`", async () => {
		// Soft-fail outcome: the install couldn't complete cleanly but isn't
		// a hard error — `vscode-continue` returns this when `code` isn't on
		// PATH or the extension install ran and failed. Row paints yellow ▲
		// with the warning text, and the key still lands in succeededKeys so
		// the parent (InstallApp) advances to Configure for this tool.
		const onDone = vi.fn(() => {});
		const { frames } = render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () => Promise.resolve({ warning: "marketplace unreachable" }),
					},
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
		const out = allFrames(frames);
		// Warned row does NOT claim "Installed pkg-a" — the install didn't
		// actually run cleanly, so the row just surfaces the warning text.
		expect(out).toContain("Warning: marketplace unreachable");
		expect(out).not.toContain("Installed pkg-a");
		expect(onDone).toHaveBeenCalledWith(["a"]);
	});

	test("warned and done keys both land in succeededKeys; only hard `failed` is dropped", async () => {
		// A mixed run: one warn, one success. Both keys reach the parent so
		// nothing is dropped from the survivor set — `warned` is recoverable
		// (the row's tool still wants Configure to run).
		const onDone = vi.fn(() => {});
		render(
			<TaskList
				tasks={[
					{
						key: "a",
						label: "pkg-a",
						run: () => Promise.resolve({ warning: "soft" }),
					},
					{ key: "b", label: "pkg-b", run: () => Promise.resolve(null) },
				]}
				verb={VERB}
				onDone={onDone}
			/>,
		);
		await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone).toHaveBeenCalledWith(["a", "b"]);
	});

	test("runs tasks in parallel", async () => {
		const order: string[] = [];
		const makeTask = (key: string, delay: number) => ({
			key,
			label: key,
			run: () =>
				new Promise<string | null>((resolve) => {
					setTimeout(() => {
						order.push(key);
						resolve(null);
					}, delay);
				}),
		});
		render(
			<TaskList
				tasks={[makeTask("slow", 40), makeTask("fast", 10)]}
				verb={VERB}
				onDone={() => {}}
			/>,
		);
		// Poll until both tasks resolve instead of sleeping a fixed window —
		// Windows CI runs ~2–3× slower than dev laptops, so a 100ms sleep
		// would land before either setTimeout fires and the assertion below
		// would see `[]`. vi.waitFor caps at the test timeout (30s in CI).
		await vi.waitFor(() => expect(order).toHaveLength(2));
		// If sequential, "slow" would finish before "fast".
		expect(order).toEqual(["fast", "slow"]);
	});
});
