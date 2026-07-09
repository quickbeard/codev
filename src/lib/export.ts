import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readAgentConfig } from "@/lib/configure.js";
import { logDebug, logInfo, logWarn } from "@/lib/log.js";
import { renderMarkdown } from "@/lib/markdown.js";
import {
	agentLogsDir,
	buildFilename,
	cliLogsDir,
	projectLogsDir,
} from "@/lib/paths.js";
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
	// Where each inactive provider looked for this project's sessions, captured
	// from Provider.describeTarget. `codev upload` surfaces these when nothing was
	// found at all, so the user can see every path checked and spot a wrong-dir
	// or wrong-tool mistake (the original Windows "Uploaded 0/0" confusion).
	targets: { agent: Agent; path: string }[];
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
	{
		agent: "codev-code",
		load: async () =>
			(await import("@/providers/codev-code.js")).codevCodeProvider,
	},
];

// Conversation exports used to live in ~/.codev/logs/<project>/; that root now
// belongs to the CLI's own diagnostic logs (lib/log.ts) and exports moved to
// ~/.codev/agent-logs/<project>/. Relocate any legacy project folders once so
// prior exports don't sit orphaned inside the diagnostics dir. Only
// directories are moved — files at the legacy root (codev-*.ndjson diagnostics
// written by a newer run) are not export data. Best-effort throughout: a
// folder that fails to move (or already exists at the destination) is left
// behind, and the next export simply regenerates its sessions at the new
// location from the agents' own data.
export function migrateLegacyAgentLogs(): void {
	const legacyRoot = cliLogsDir();
	const targetRoot = agentLogsDir();
	let entries: Dirent[];
	try {
		entries = readdirSync(legacyRoot, { withFileTypes: true });
	} catch {
		return; // No legacy dir — nothing to migrate.
	}
	let moved = 0;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const to = join(targetRoot, entry.name);
		try {
			if (existsSync(to)) continue; // Re-exported already; keep the newer copy.
			mkdirSync(targetRoot, { recursive: true });
			renameSync(join(legacyRoot, entry.name), to);
			moved++;
		} catch {
			// Best-effort.
		}
	}
	if (moved > 0) {
		logInfo(`migrated ${moved} legacy export folder(s) to agent-logs`, {
			extra: { moved },
		});
	}
}

export async function runExport(
	onStatus: StatusReporter = () => {},
): Promise<ExportSummary> {
	const cwd = process.cwd();
	migrateLegacyAgentLogs();
	const outDir = projectLogsDir(cwd);
	mkdirSync(outDir, { recursive: true });

	const stats = new StatisticsCollector();
	const summary: ExportSummary = {
		outDir,
		exported: 0,
		byAgent: {},
		skipped: [],
		errors: [],
		targets: [],
	};

	for (const { agent, load } of PROVIDER_LOADERS) {
		onStatus(`Checking ${agent}...`);
		let provider: Provider;
		try {
			provider = await load();
		} catch (err) {
			summary.errors.push({ agent, message: String(err) });
			logWarn(`provider ${agent} failed to load`, {
				action: "export.provider",
				outcome: "failure",
				err,
				extra: { agent },
			});
			continue;
		}
		let active: boolean;
		try {
			active = await provider.detect(cwd);
		} catch (err) {
			summary.errors.push({ agent: provider.agent, message: String(err) });
			logWarn(`provider ${agent} detect failed`, {
				action: "export.provider",
				outcome: "failure",
				err,
				extra: { agent },
			});
			continue;
		}
		if (!active) {
			summary.skipped.push(provider.agent);
			// Surface where we looked. Detection misses are almost always a
			// path-encoding mismatch (notably Windows project-dir munging), and the
			// only way to debug that remotely is to see the exact path the provider
			// inspected — so it goes in the message, visible in plain `codev logs`,
			// not just behind --verbose.
			const target = provider.describeTarget(cwd);
			summary.targets.push({ agent: provider.agent, path: target });
			logDebug(`provider ${agent} inactive for this project (${target})`, {
				action: "export.provider",
				extra: { agent, skipped: true, target },
			});
			continue;
		}

		onStatus(`Reading ${provider.agent} sessions...`);
		let sessions: Awaited<ReturnType<Provider["listSessions"]>>;
		try {
			sessions = await provider.listSessions(cwd);
		} catch (err) {
			summary.errors.push({ agent: provider.agent, message: String(err) });
			logWarn(`provider ${agent} failed to read sessions`, {
				action: "export.provider",
				outcome: "failure",
				err,
				extra: { agent },
			});
			continue;
		}

		if (sessions.length === 0) {
			summary.skipped.push(provider.agent);
			logDebug(`provider ${agent} has no sessions for this project`, {
				action: "export.provider",
				extra: { agent, skipped: true },
			});
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
		logInfo(`exported ${sessions.length} ${provider.agent} session(s)`, {
			action: "export.provider",
			outcome: "success",
			extra: { agent: provider.agent, sessions: sessions.length },
		});
	}

	stats.flush(join(outDir, "statistics.json"));
	return summary;
}
