import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import { openCodeSkillsDir, skillsDir } from "@/lib/paths.js";
import { extractSkill } from "@/lib/skill-archive.js";
import { downloadSkill, type HubSkill, searchSkills } from "@/lib/skillhub.js";

export type SkillAgent = "claude" | "opencode";

type Phase = "searching" | "downloading" | "extracting" | "done" | "error";

interface Props {
	name: string;
	agent?: SkillAgent;
	force?: boolean;
}

function resolveSkillsDir(agent: SkillAgent): string {
	return agent === "opencode" ? openCodeSkillsDir() : skillsDir();
}

function agentLabel(agent: SkillAgent): string {
	return agent === "opencode"
		? "~/.config/opencode/skills"
		: "~/.claude/skills";
}

export function SkillInstallApp({
	name,
	agent = "claude",
	force = false,
}: Props) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("searching");
	const [skill, setSkill] = useState<HubSkill | null>(null);
	const [error, setError] = useState("");
	const didRun = useRef(false);

	useEffect(() => {
		if (didRun.current) return;
		didRun.current = true;

		(async () => {
			// Phase: searching
			const results = await searchSkills(name, 10);
			const found = results.find(
				(s) => s.name.toLowerCase() === name.toLowerCase(),
			);
			if (!found) {
				const suggestions = results
					.slice(0, 3)
					.map((s) => s.name)
					.join(", ");
				const hint = suggestions ? ` Did you mean: ${suggestions}?` : "";
				throw new Error(`Skill not found: ${name}.${hint}`);
			}
			const dest = join(resolveSkillsDir(agent), name);
			if (existsSync(dest) && !force) {
				throw new Error(
					`"${name}" is already installed. Run with --force to overwrite.`,
				);
			}
			setSkill(found);
			setPhase("downloading");

			// Phase: downloading
			const buffer = await downloadSkill(found.id);
			setPhase("extracting");

			// Phase: extracting
			await extractSkill(buffer, dest);
			setPhase("done");
		})().catch((e: unknown) => {
			setError(e instanceof Error ? e.message : String(e));
			setPhase("error");
		});
	}, [name, agent, force]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 500);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	const isActive = phase !== "done" && phase !== "error";
	const label = agentLabel(agent);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="skill install">
				<Step active={isActive} title={<Text bold>Installing {name}</Text>}>
					{phase === "searching" && <Text dimColor>Searching SkillHub...</Text>}
					{phase === "downloading" && skill != null && (
						<Text dimColor>
							Downloading {skill.name} v{skill.version}...
						</Text>
					)}
					{phase === "extracting" && (
						<Text dimColor>
							Extracting to {label}/{name}/...
						</Text>
					)}
					{phase === "done" && (
						<Box flexDirection="column">
							<Text color="green">
								✓ Installed to {label}/{name}/
							</Text>
							<Text dimColor>{SKILLHUB_REGISTRY}</Text>
						</Box>
					)}
					{phase === "error" && <Text color="red">✗ {error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
