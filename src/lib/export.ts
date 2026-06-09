import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentConfig } from "@/lib/configure.js";
import { renderMarkdown } from "@/lib/markdown.js";
import { buildFilename, projectLogsDir } from "@/lib/paths.js";
import {
	computeSessionStatistics,
	StatisticsCollector,
} from "@/lib/statistics.js";
import type { Agent, Provider } from "@/providers/types.js";

export interface ExportSummary {
	outDir: string;
	exported: number;
	byAgent: Partial<Record<Agent, number>>;
	skipped: Agent[];
	errors: { agent: Agent; message: string }[];
}

export type StatusReporter = (message: string) => void;

// Each provider is loaded only when about to be used. Top-level imports would
// pull every provider's runtime deps (e.g. better-sqlite3 for opencode) into
// the link graph of any command — including `--version` — and a single broken
// provider would take the whole CLI down at module-link time.
const PROVIDER_LOADERS: { agent: Agent; load: () => Promise<Provider> }[] = [
	{
		agent: "claude-code",
		load: async () =>
			(await import("@/providers/claude-code.js")).claudeCodeProvider,
	},
	{
		agent: "codex",
		load: async () => (await import("@/providers/codex.js")).codexProvider,
	},
	{
		agent: "opencode",
		load: async () =>
			(await import("@/providers/opencode.js")).openCodeProvider,
	},
];

export async function runExport(
	onStatus: StatusReporter = () => {},
): Promise<ExportSummary> {
	const cwd = process.cwd();
	const outDir = projectLogsDir(cwd);
	mkdirSync(outDir, { recursive: true });

	const stats = new StatisticsCollector();
	const summary: ExportSummary = {
		outDir,
		exported: 0,
		byAgent: {},
		skipped: [],
		errors: [],
	};

	for (const { agent, load } of PROVIDER_LOADERS) {
		onStatus(`Checking ${agent}...`);
		let provider: Provider;
		try {
			provider = await load();
		} catch (err) {
			summary.errors.push({ agent, message: String(err) });
			continue;
		}
		let active: boolean;
		try {
			active = await provider.detect(cwd);
		} catch (err) {
			summary.errors.push({ agent: provider.agent, message: String(err) });
			continue;
		}
		if (!active) {
			summary.skipped.push(provider.agent);
			continue;
		}

		onStatus(`Reading ${provider.agent} sessions...`);
		let sessions: Awaited<ReturnType<Provider["listSessions"]>>;
		try {
			sessions = await provider.listSessions(cwd);
		} catch (err) {
			summary.errors.push({ agent: provider.agent, message: String(err) });
			continue;
		}

		if (sessions.length === 0) {
			summary.skipped.push(provider.agent);
			continue;
		}

		onStatus(`Writing ${provider.agent} (${sessions.length})...`);
		const agentDir = join(outDir, provider.agent);
		mkdirSync(agentDir, { recursive: true });
		// Read the tool's CoDev-managed config once and inject baseUrl into every
		// session from this provider. The worker uses base_url in the session
		// comment to determine internal vs external model usage.
		const agentConfig = readAgentConfig(provider.agent);
		for (const session of sessions) {
			session.baseUrl = agentConfig.baseUrl;
			const filename = buildFilename(session);
			const filePath = join(agentDir, filename);
			const md = renderMarkdown(session);
			writeFileSync(filePath, md);
			stats.add(session.id, computeSessionStatistics(session, md));
			summary.exported++;
			summary.byAgent[provider.agent] =
				(summary.byAgent[provider.agent] ?? 0) + 1;
		}
	}

	stats.flush(join(outDir, "statistics.json"));
	return summary;
}
