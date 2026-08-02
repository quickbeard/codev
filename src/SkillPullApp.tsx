import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { useCanType } from "@/components/useCanType.js";
import { t } from "@/lib/i18n.js";
import { stripControlChars } from "@/lib/sanitize.js";
import {
	AGENT_LABELS,
	ALWAYS_AGENT,
	SKILL_AGENTS,
	type SkillAgent,
} from "@/lib/skill-dirs.js";
import {
	defaultAgents,
	formatInstallResult,
	type InstallLocation,
	type InstallResult,
	installResolvedSkill,
} from "@/lib/skill-install.js";
import { getSkillMeta, type SkillMeta } from "@/lib/skillhub.js";

interface SkillPullAppProps {
	target: string;
	force: boolean;
	json: boolean;
	// Agent set from --agent/--all-agents. Absent ⇒ prompt for it, pre-checked
	// with defaultAgents().
	agents?: SkillAgent[];
	// Reports success/failure so the caller can set the process exit code, then
	// the app exits on its own. Optional so tests can omit it.
	onDone?: (ok: boolean) => void;
}

type Phase =
	| "resolving"
	| "select"
	| "agents"
	| "installing"
	| "done"
	| "error";

// Labels resolved per render rather than frozen at import time.
const LOCATIONS = [
	{
		key: "current" as InstallLocation,
		labelKey: "skill_pull.location.current",
	},
	{ key: "global" as InstallLocation, labelKey: "skill_pull.location.global" },
] as const;

export function SkillPullApp({
	target,
	force,
	json,
	agents,
	onDone,
}: SkillPullAppProps) {
	const { exit } = useApp();
	const canType = useCanType();
	const [phase, setPhase] = useState<Phase>("resolving");
	const [meta, setMeta] = useState<SkillMeta | null>(null);
	const [index, setIndex] = useState(0);
	const [result, setResult] = useState<InstallResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [scope, setScope] = useState<InstallLocation>("current");
	const [agentIndex, setAgentIndex] = useState(0);
	// Pre-check: whatever CoDev has configured, plus the always-on flagship.
	// Computed once — detectCodevTools() hits the filesystem.
	const [picked, setPicked] = useState<Set<SkillAgent>>(
		() => new Set(agents ?? defaultAgents()),
	);

	// Signal the outcome, then unmount. exit() takes no error — the exit code is
	// carried by onDone — so waitUntilExit resolves cleanly either way.
	const finish = useCallback(
		(ok: boolean) => {
			onDone?.(ok);
			// Hold a successful frame briefly so it's readable; drop fast on error.
			setTimeout(() => exit(), ok ? 500 : 20);
		},
		[onDone, exit],
	);

	// Resolve the skill's real name up front so the prompt shows the name (never
	// a raw id) and the install dir is named after it.
	useEffect(() => {
		let cancelled = false;
		getSkillMeta(target)
			.then((m) => {
				if (cancelled) return;
				setMeta(m);
				setPhase("select");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				finish(false);
			});
		return () => {
			cancelled = true;
		};
	}, [target, finish]);

	const start = useCallback(
		async (location: InstallLocation, chosen: readonly SkillAgent[]) => {
			if (!meta) return;
			setPhase("installing");
			try {
				const r = await installResolvedSkill(meta, {
					target: { kind: "agents", agents: [...chosen], scope: location },
					force,
				});
				setResult(r);
				setPhase("done");
				finish(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				finish(false);
			}
		},
		[meta, force, finish],
	);

	// The dispatcher already routes a keyboard-less terminal to the plain runner,
	// so reaching a prompt without one means Ink's stdin isn't the process's own.
	// Say so and exit rather than mounting a picker that can never be answered:
	// unlike the ungated case this is a silent hang, not a throw.
	useEffect(() => {
		if ((phase !== "select" && phase !== "agents") || canType) return;
		setError(t("skill_pull.no_keyboard"));
		setPhase("error");
		finish(false);
	}, [phase, canType, finish]);

	useInput(
		(_input, key) => {
			if (phase !== "select") return;
			if (key.upArrow) {
				setIndex((i) => (i === 0 ? LOCATIONS.length - 1 : i - 1));
			} else if (key.downArrow) {
				setIndex((i) => (i + 1) % LOCATIONS.length);
			} else if (key.return) {
				const location = LOCATIONS[index]?.key ?? "current";
				setScope(location);
				// An explicit --agent/--all-agents already answered the second
				// question; don't ask it again.
				if (agents) {
					void start(location, agents);
					return;
				}
				setPhase("agents");
			}
		},
		{ isActive: canType && phase === "select" },
	);

	useInput(
		(input, key) => {
			if (phase !== "agents") return;
			if (key.upArrow) {
				setAgentIndex((i) => (i === 0 ? SKILL_AGENTS.length - 1 : i - 1));
			} else if (key.downArrow) {
				setAgentIndex((i) => (i + 1) % SKILL_AGENTS.length);
			} else if (input === " ") {
				const agent = SKILL_AGENTS[agentIndex];
				// CoDev Code is the flagship and is never opted out of.
				if (!agent || agent === ALWAYS_AGENT) return;
				setPicked((prev) => {
					const next = new Set(prev);
					if (next.has(agent)) next.delete(agent);
					else next.add(agent);
					return next;
				});
			} else if (key.return) {
				void start(
					scope,
					SKILL_AGENTS.filter((a) => picked.has(a)),
				);
			}
		},
		{ isActive: canType && phase === "agents" },
	);

	// Sanitize the hub-sourced name before rendering it to the terminal.
	const skillName = meta ? stripControlChars(meta.name) : null;
	const title = skillName
		? t("skill_pull.title", { name: skillName })
		: t("skill_pull.title_generic");

	return (
		<Box flexDirection="column" paddingX={1} paddingBottom={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step active title={<Text bold>{title}</Text>}>
					{phase === "resolving" && (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{` ${t("skill_pull.resolving")}`}</Text>
						</Box>
					)}
					{phase === "select" && meta && (
						<Box flexDirection="column">
							<Text dimColor>
								{t("skill_pull.install_to", { name: skillName ?? "" })}
							</Text>
							{LOCATIONS.map((loc, i) => (
								<Text key={loc.key} color={i === index ? "cyan" : undefined}>
									{`${i === index ? "❯ " : "  "}${t(loc.labelKey)}`}
								</Text>
							))}
						</Box>
					)}
					{phase === "agents" && (
						<Box flexDirection="column">
							<Text dimColor>{t("skill_pull.which_agents")}</Text>
							{SKILL_AGENTS.map((agent, i) => {
								const locked = agent === ALWAYS_AGENT;
								const checked = locked || picked.has(agent);
								return (
									<Text
										key={agent}
										color={i === agentIndex ? "cyan" : undefined}
										dimColor={locked}
									>
										{`${i === agentIndex ? "❯ " : "  "}[${checked ? "✓" : " "}] ${AGENT_LABELS[agent]}`}
									</Text>
								);
							})}
							<Text dimColor>{t("skill_pull.toggle_hint")}</Text>
						</Box>
					)}
					{phase === "installing" && (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{` ${t("skill_pull.installing")}`}</Text>
						</Box>
					)}
					{phase === "done" && result && (
						<Text color={json ? undefined : "green"}>
							{formatInstallResult(result, json)}
						</Text>
					)}
					{phase === "error" && error && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
