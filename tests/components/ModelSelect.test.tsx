import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelSelect } from "@/components/ModelSelect.js";
import * as proxy from "@/lib/proxy.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

async function tick(ms = 30): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("ModelSelect", () => {
	test("renders the loading spinner while fetching", () => {
		// Never resolve, so we stay in the loading phase for assertion.
		vi.spyOn(proxy, "fetchModels").mockImplementation(
			() => new Promise(() => {}),
		);
		const { lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={() => {}} onError={() => {}} />,
		);
		expect(lastFrame() ?? "").toContain("Fetching available models");
	});

	test("renders the model list after fetch resolves", async () => {
		vi.spyOn(proxy, "fetchModels").mockResolvedValue(["alpha", "beta"]);
		const { lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={() => {}} onError={() => {}} />,
		);
		await tick(50);
		const out = lastFrame() ?? "";
		expect(out).toContain("alpha");
		expect(out).toContain("beta");
	});

	test("Enter on the default cursor invokes onSelect with the first model", async () => {
		vi.spyOn(proxy, "fetchModels").mockResolvedValue(["alpha", "beta"]);
		const onSelect = vi.fn();
		const { stdin, lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={onSelect} onError={() => {}} />,
		);
		// Poll for the list to render, then settle so useInput is registered
		// before the keypress — fixed-time ticks alone aren't reliable on
		// slower CI runners.
		await vi.waitFor(() => expect(lastFrame() ?? "").toContain("alpha"));
		await tick();
		stdin.write("\r");
		await vi.waitFor(() => expect(onSelect).toHaveBeenCalled());
		expect(onSelect).toHaveBeenCalledWith("alpha", ["alpha", "beta"]);
	});

	test("down-arrow then Enter selects the second model", async () => {
		vi.spyOn(proxy, "fetchModels").mockResolvedValue(["alpha", "beta"]);
		const onSelect = vi.fn();
		const { stdin, lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={onSelect} onError={() => {}} />,
		);
		await vi.waitFor(() => expect(lastFrame() ?? "").toContain("beta"));
		// Settle before sending the arrow key: vi.waitFor returns the moment
		// "beta" first appears in a frame, which is the same render that
		// mounts useInput — without this delay, the arrow press can land
		// before the handler is active and be dropped.
		await tick();
		stdin.write("\x1B[B"); // ↓
		await tick();
		stdin.write("\r");
		await vi.waitFor(() => expect(onSelect).toHaveBeenCalled());
		expect(onSelect).toHaveBeenCalledWith("beta", ["alpha", "beta"]);
	});

	test("fetch rejection calls onError exactly once", async () => {
		vi.spyOn(proxy, "fetchModels").mockRejectedValue(
			new Error("Models fetch failed (401): invalid key"),
		);
		const onError = vi.fn();
		render(
			<ModelSelect apiKey="sk-bad" onSelect={() => {}} onError={onError} />,
		);
		await tick(50);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]?.message).toContain("401");
	});

	test("passes baseUrl through to fetchModels", async () => {
		const spy = vi.spyOn(proxy, "fetchModels").mockResolvedValue(["alpha"]);
		render(
			<ModelSelect
				apiKey="sk-x"
				baseUrl="https://my-gw.example.com/v1"
				onSelect={() => {}}
				onError={() => {}}
			/>,
		);
		await tick(50);
		expect(spy).toHaveBeenCalledWith("sk-x", "https://my-gw.example.com/v1");
	});

	test("readOnly ignores Enter even after the list is ready", async () => {
		vi.spyOn(proxy, "fetchModels").mockResolvedValue(["alpha"]);
		const onSelect = vi.fn();
		const { stdin } = render(
			<ModelSelect
				apiKey="sk-x"
				onSelect={onSelect}
				onError={() => {}}
				readOnly
			/>,
		);
		await tick(50);
		stdin.write("\r");
		await tick();
		expect(onSelect).not.toHaveBeenCalled();
	});

	test("renders the error message and retry prompt after a fetch failure", async () => {
		vi.spyOn(proxy, "fetchModels").mockRejectedValue(
			new Error("Models fetch failed (502): boom"),
		);
		const { lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={() => {}} onError={() => {}} />,
		);
		await vi.waitFor(() =>
			expect(lastFrame() ?? "").toContain("Press Enter to retry"),
		);
		const out = lastFrame() ?? "";
		expect(out).toContain("Failed to fetch models");
		expect(out).toContain("Models fetch failed (502): boom");
		// No list rows once the component has settled into the errored frame.
		expect(out).not.toContain("○");
	});

	test("Enter on the errored frame re-runs fetchModels", async () => {
		const spy = vi
			.spyOn(proxy, "fetchModels")
			.mockRejectedValueOnce(new Error("Models fetch failed (502): boom"))
			.mockResolvedValue(["alpha", "beta"]);
		const onSelect = vi.fn();
		const onError = vi.fn();
		const { stdin, lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={onSelect} onError={onError} />,
		);
		await vi.waitFor(() =>
			expect(lastFrame() ?? "").toContain("Press Enter to retry"),
		);
		// Settle so useInput is registered before the keypress.
		await tick();
		stdin.write("\r");
		await vi.waitFor(() => expect(lastFrame() ?? "").toContain("alpha"));
		expect(spy).toHaveBeenCalledTimes(2);
		// onError fired once per failed attempt; the successful retry doesn't
		// fire it again.
		expect(onError).toHaveBeenCalledTimes(1);
	});

	test("a second failure after retry fires onError again (auth-routing parents need this)", async () => {
		vi.spyOn(proxy, "fetchModels")
			.mockRejectedValueOnce(new Error("Models fetch failed (502): boom"))
			.mockRejectedValue(new Error("Models fetch failed (401): invalid key"));
		const onError = vi.fn();
		const { stdin, lastFrame } = render(
			<ModelSelect apiKey="sk-x" onSelect={() => {}} onError={onError} />,
		);
		await vi.waitFor(() =>
			expect(lastFrame() ?? "").toContain("Press Enter to retry"),
		);
		await tick();
		stdin.write("\r");
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
		expect(onError.mock.calls[0]?.[0]?.message).toContain("502");
		expect(onError.mock.calls[1]?.[0]?.message).toContain("401");
	});
});
