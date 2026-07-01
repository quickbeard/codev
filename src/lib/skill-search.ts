import { type HubSkill, listHubSkills } from "@/lib/skillhub.js";

const DEFAULT_LIMIT = 20;
const DESCRIPTION_MAX = 90;

// `codev skill search <query> [--json] [--limit <n>]`. Plain console output
// (no Ink) so results pipe cleanly and `--json` is script-friendly — mirrors
// the deprecated `skillhub search`. The query is required. Returns the exit code.
export async function runSkillSearch(args: string[]): Promise<number> {
	const json = args.includes("--json");

	let limit = DEFAULT_LIMIT;
	const limitIdx = args.indexOf("--limit");
	if (limitIdx !== -1) {
		const parsed = Number.parseInt(args[limitIdx + 1] ?? "", 10);
		if (Number.isNaN(parsed) || parsed <= 0) {
			console.error("Invalid --limit: expected a positive integer.");
			return 1;
		}
		limit = parsed;
	}

	// Everything that isn't a flag (or the value right after --limit) is the
	// query. Joined so an unquoted multi-word query still works.
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--limit") {
			i++; // skip its value
			continue;
		}
		if (args[i]?.startsWith("--")) continue;
		positionals.push(args[i] as string);
	}
	const query = positionals.join(" ").trim();
	if (!query) {
		console.error("Usage: codev skill search <query> [--json] [--limit <n>]");
		return 1;
	}

	try {
		const { total, items } = await listHubSkills({ search: query, limit });

		if (json) {
			console.log(JSON.stringify({ ok: true, total, items }));
			return 0;
		}
		if (items.length === 0) {
			console.log(`No skills match "${query}".`);
			return 0;
		}
		console.log(formatResults(total, items));
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

function formatResults(total: number, items: HubSkill[]): string {
	const lines = [`Found ${total} skill(s) — showing ${items.length}:`, ""];
	for (const s of items) {
		lines.push(`  ${s.name}@${s.version} by ${s.provider}`);
		const desc = s.description ?? "";
		const trimmed =
			desc.length > DESCRIPTION_MAX
				? `${desc.slice(0, DESCRIPTION_MAX - 3)}...`
				: desc;
		if (trimmed) lines.push(`    ${trimmed}`);
		lines.push(`    id: ${s.id}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
