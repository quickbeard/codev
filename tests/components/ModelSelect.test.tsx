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

function frames(arr: string[]): string {
	return arr.join("\n");
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
		const { stdin } = render(
			<ModelSelect apiKey="sk-x" onSelect={onSelect} onError={() => {}} />,
		);
		await tick(50);
		stdin.write("\r");
		await tick();
		expect(onSelect).toHaveBeenCalledWith("alpha");
	});

	test("down-arrow then Enter selects the second model", async () => {
		vi.spyOn(proxy, "fetchModels").mockResolvedValue(["alpha", "beta"]);
		const onSelect = vi.fn();
		const { stdin } = render(
			<ModelSelect apiKey="sk-x" onSelect={onSelect} onError={() => {}} />,
		);
		await tick(50);
		stdin.write("\x1B[B"); // ↓
		await tick();
		stdin.write("\r");
		await tick();
		expect(onSelect).toHaveBeenCalledWith("beta");
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

	test("renders nothing visible after an error (parent owns the error frame)", async () => {
		vi.spyOn(proxy, "fetchModels").mockRejectedValue(new Error("nope"));
		const { frames: f } = render(
			<ModelSelect apiKey="sk-x" onSelect={() => {}} onError={() => {}} />,
		);
		await tick(50);
		// The component should not have rendered a model list after errored;
		// the spinner line may have appeared during loading, which is fine.
		expect(frames(f)).not.toContain("○");
	});
});
