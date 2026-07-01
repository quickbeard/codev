import { afterEach, describe, expect, test, vi } from "vitest";
import { runSkillSearch } from "@/lib/skill-search.js";
import * as skillhub from "@/lib/skillhub.js";

function mockSearch(items: skillhub.HubSkill[], total = items.length) {
	return vi
		.spyOn(skillhub, "listHubSkills")
		.mockResolvedValue({ total, items });
}

function captureLog() {
	const out: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
		out.push(String(m));
	});
	return out;
}

function captureErr() {
	const out: string[] = [];
	vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
		out.push(String(m));
	});
	return out;
}

const SKILL: skillhub.HubSkill = {
	id: "id-1",
	name: "pg-tuner",
	provider: "viettel",
	description: "Tune Postgres configs",
	version: "1.2.0",
	publishedAt: "2026-06-01",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runSkillSearch", () => {
	test("passes the joined query and default limit to listHubSkills", async () => {
		const spy = mockSearch([SKILL]);
		captureLog();

		const code = await runSkillSearch(["postgres", "tuning"]);

		expect(code).toBe(0);
		expect(spy).toHaveBeenCalledWith({ search: "postgres tuning", limit: 20 });
	});

	test("parses --limit alongside the query", async () => {
		const spy = mockSearch([SKILL]);
		captureLog();

		await runSkillSearch(["pg", "--limit", "5"]);

		expect(spy).toHaveBeenCalledWith({ search: "pg", limit: 5 });
	});

	test("renders a human-readable list", async () => {
		mockSearch([SKILL], 7);
		const out = captureLog();

		await runSkillSearch(["pg"]);

		const text = out.join("\n");
		expect(text).toContain("Found 7 skill(s) — showing 1:");
		expect(text).toContain("pg-tuner@1.2.0 by viettel");
		expect(text).toContain("Tune Postgres configs");
		expect(text).toContain("id: id-1");
	});

	test("emits JSON with --json (no human text)", async () => {
		mockSearch([SKILL], 7);
		const out = captureLog();

		const code = await runSkillSearch(["pg", "--json"]);

		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		const parsed = JSON.parse(out[0] as string);
		expect(parsed).toEqual({ ok: true, total: 7, items: [SKILL] });
	});

	test("shows a query-specific message when there are no matches", async () => {
		mockSearch([]);
		const out = captureLog();

		await runSkillSearch(["nope"]);

		expect(out.join("\n")).toBe('No skills match "nope".');
	});

	test("requires a query (errors without calling the API)", async () => {
		const spy = mockSearch([SKILL]);
		const errs = captureErr();

		const code = await runSkillSearch([]);

		expect(code).toBe(1);
		expect(spy).not.toHaveBeenCalled();
		expect(errs.join("\n")).toMatch(/Usage: codev skill search <query>/);
	});

	test("rejects a non-positive --limit without calling the API", async () => {
		const spy = mockSearch([SKILL]);
		const errs = captureErr();

		const code = await runSkillSearch(["--limit", "0"]);

		expect(code).toBe(1);
		expect(spy).not.toHaveBeenCalled();
		expect(errs.join("\n")).toMatch(/positive integer/i);
	});

	test("returns exit code 1 and prints the error when the API throws", async () => {
		vi.spyOn(skillhub, "listHubSkills").mockRejectedValue(
			new Error("Skill search failed (500)."),
		);
		const errs = captureErr();

		const code = await runSkillSearch(["pg"]);

		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("Skill search failed (500).");
	});
});
