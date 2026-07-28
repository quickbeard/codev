import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type MockInstance,
	test,
	vi,
} from "vitest";
import * as auth from "@/lib/auth.js";
import * as backend from "@/lib/backend.js";
import * as configure from "@/lib/configure.js";
import { ensureFreshGatewayKey } from "@/lib/refresh.js";

let stderr: MockInstance;

beforeEach(() => {
	stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function stderrText(): string {
	return stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

const CREDS = {
	apiKey: "sk-old",
	baseUrl: undefined,
	model: "MiniMax/MiniMax-M2.7",
};

function fakeSession() {
	return {
		access_token: "sso-token",
		id_token: "id",
		expires_at: Date.now() + 3_600_000,
		user: { sub: "s", email: "e@example.com", displayName: "E" },
	};
}

describe("ensureFreshGatewayKey", () => {
	test("no-op when there is no CoDev-managed key", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(null);
		const validate = vi.spyOn(backend, "validateApiKey");
		await ensureFreshGatewayKey("claude-code");
		expect(validate).not.toHaveBeenCalled();
	});

	test("no-op when the saved key has no model", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue({ apiKey: "sk-x" });
		const validate = vi.spyOn(backend, "validateApiKey");
		await ensureFreshGatewayKey("claude-code");
		expect(validate).not.toHaveBeenCalled();
	});

	test("no-op when the key is still valid", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(true);
		const save = vi.spyOn(auth, "saveApiKey");
		const fetchKey = vi.spyOn(backend, "fetchApiKey");
		const cfg = vi.spyOn(configure, "configureClaudeCode");
		await ensureFreshGatewayKey("claude-code");
		expect(save).not.toHaveBeenCalled();
		expect(fetchKey).not.toHaveBeenCalled();
		expect(cfg).not.toHaveBeenCalled();
	});

	test("refreshes and reconfigures when the key is rejected", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "silentSso").mockResolvedValue(fakeSession());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-new");
		const save = vi.spyOn(auth, "saveApiKey").mockImplementation(() => {});
		const cfg = vi.spyOn(configure, "configureClaudeCode").mockReturnValue([]);

		await ensureFreshGatewayKey("claude-code");

		const expected = {
			apiKey: "sk-new",
			baseUrl: undefined,
			model: "MiniMax/MiniMax-M2.7",
			providerId: undefined,
			providerName: undefined,
		};
		expect(save).toHaveBeenCalledWith(expected);
		expect(cfg).toHaveBeenCalledWith(expected);
		expect(stderrText()).toContain("Refreshed your expired gateway API key");
	});

	test("keeps a manually-named provider across the refresh", async () => {
		// The reconfigure rewrites the whole agent config, so dropping the
		// provider here would silently re-label the user's provider as the
		// netGate default on the next agent launch.
		vi.spyOn(auth, "loadApiKey").mockReturnValue({
			...CREDS,
			baseUrl: "https://acme.example.com/v1",
			providerId: "acme-ai",
			providerName: "Acme AI",
		});
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "silentSso").mockResolvedValue(fakeSession());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-new");
		const save = vi.spyOn(auth, "saveApiKey").mockImplementation(() => {});
		const cfg = vi.spyOn(configure, "configureClaudeCode").mockReturnValue([]);

		await ensureFreshGatewayKey("claude-code");

		const expected = {
			apiKey: "sk-new",
			baseUrl: "https://acme.example.com/v1",
			model: "MiniMax/MiniMax-M2.7",
			providerId: "acme-ai",
			providerName: "Acme AI",
		};
		expect(save).toHaveBeenCalledWith(expected);
		expect(cfg).toHaveBeenCalledWith(expected);
	});

	test("routes the reconfigure to the launched tool (codex, not claude)", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "silentSso").mockResolvedValue(fakeSession());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-new");
		vi.spyOn(auth, "saveApiKey").mockImplementation(() => {});
		const claude = vi
			.spyOn(configure, "configureClaudeCode")
			.mockReturnValue([]);
		const codex = vi.spyOn(configure, "configureCodex").mockReturnValue([]);

		await ensureFreshGatewayKey("codex");

		expect(codex).toHaveBeenCalled();
		expect(claude).not.toHaveBeenCalled();
	});

	test("routes the reconfigure to the launched tool (codev-code, not opencode)", async () => {
		// configureCodevCode rewrites ~/.config/codev-code/opencode.json — the
		// fork must not have its refresh land in stock opencode's config.
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "silentSso").mockResolvedValue(fakeSession());
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("sk-new");
		vi.spyOn(auth, "saveApiKey").mockImplementation(() => {});
		const opencode = vi
			.spyOn(configure, "configureOpenCode")
			.mockReturnValue([]);
		const codevCode = vi
			.spyOn(configure, "configureCodevCode")
			.mockReturnValue([]);

		await ensureFreshGatewayKey("codev-code");

		expect(codevCode).toHaveBeenCalled();
		expect(opencode).not.toHaveBeenCalled();
	});

	test("hints to reinstall when the session can't be refreshed silently", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "silentSso").mockResolvedValue(null);
		const fetchKey = vi.spyOn(backend, "fetchApiKey");
		const cfg = vi.spyOn(configure, "configureClaudeCode");

		await ensureFreshGatewayKey("claude-code");

		expect(fetchKey).not.toHaveBeenCalled();
		expect(cfg).not.toHaveBeenCalled();
		expect(stderrText()).toContain("codevhub install");
	});

	test("hints when a fresh key cannot be obtained", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockResolvedValue(false);
		vi.spyOn(auth, "silentSso").mockResolvedValue(fakeSession());
		// Gateway returned an empty key (backend maps that to "").
		vi.spyOn(backend, "fetchApiKey").mockResolvedValue("");
		const save = vi.spyOn(auth, "saveApiKey");

		await ensureFreshGatewayKey("claude-code");

		expect(save).not.toHaveBeenCalled();
		expect(stderrText()).toContain("codevhub install");
	});

	test("leaves config alone when validation errors (can't prove the key is dead)", async () => {
		vi.spyOn(auth, "loadApiKey").mockReturnValue(CREDS);
		vi.spyOn(backend, "validateApiKey").mockRejectedValue(
			new Error("ECONNREFUSED"),
		);
		const sso = vi.spyOn(auth, "silentSso");

		await ensureFreshGatewayKey("claude-code");

		expect(sso).not.toHaveBeenCalled();
	});

	test("never throws, even if a dependency blows up", async () => {
		vi.spyOn(auth, "loadApiKey").mockImplementation(() => {
			throw new Error("boom");
		});
		await expect(ensureFreshGatewayKey("claude-code")).resolves.toBeUndefined();
	});
});
