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
import {
	downloadSkill,
	downloadSkillVersion,
	type HubSkill,
	searchSkills,
} from "@/lib/skillhub.js";

export type SkillAgent = "claude" | "opencode";

type Phase = "searching" | "downloading" | "extracting" | "done" | "error";

interface Props {
	name: string;
	agent?: SkillAgent;
	force?: boolean;
}

/**
 * Parse the raw name argument into its parts.
 * Supported formats:
 *   skill-name
 *   author/skill-name
 *   skill-name@1.0.0
 *   author/skill-name@1.0.0
 */
function parseName(raw: string): {
	author: string | undefined;
	skillName: string;
	version: string | undefined;
} {
	let rest = raw;
	let author: string | undefined;
	let version: string | undefined;

	const slashIdx = rest.indexOf("/");
	if (slashIdx !== -1) {
		author = rest.slice(0, slashIdx);
		rest = rest.slice(slashIdx + 1);
	}

	const atIdx = rest.lastIndexOf("@");
	if (atIdx !== -1) {
		version = rest.slice(atIdx + 1);
		rest = rest.slice(0, atIdx);
	}

	return { author, skillName: rest, version };
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
	const [resolvedVersion, setResolvedVersion] = useState("");
	const [error, setError] = useState("");
	const didRun = useRef(false);

	const { author, skillName, version } = parseName(name);

	useEffect(() => {
		if (didRun.current) return;
		didRun.current = true;

		(async () => {
			// Phase: searching
			const results = await searchSkills(skillName, 20);
			const matches = results.filter(
				(s) => s.name.toLowerCase() === skillName.toLowerCase(),
			);

			let found: HubSkill;

			if (author) {
				// Author specified — require exact author match
				const match = matches.find(
					(s) => s.author?.username.toLowerCase() === author.toLowerCase(),
				);
				if (!match) {
					const available = matches
						.map((s) => s.author?.username ?? "unknown")
						.join(", ");
					const hint = available
						? ` Found "${skillName}" from: ${available}.`
						: "";
					throw new Error(`Skill "${author}/${skillName}" not found.${hint}`);
				}
				found = match;
			} else if (matches.length > 1) {
				// Ambiguous — multiple skills with the same name
				const authors = matches
					.map((s) => s.author?.username ?? "unknown")
					.join(", ");
				throw new Error(
					`Multiple skills named "${skillName}" found (from: ${authors}).\n` +
						`Use <author>/${skillName} to specify, e.g.:\n` +
						`  codev skill install ${matches[0]?.author?.username ?? "author"}/${skillName}`,
				);
			} else if (matches.length === 1 && matches[0] !== undefined) {
				found = matches[0];
			} else {
				const suggestions = results
					.slice(0, 3)
					.map((s) => s.name)
					.join(", ");
				const hint = suggestions ? ` Did you mean: ${suggestions}?` : "";
				throw new Error(`Skill not found: ${skillName}.${hint}`);
			}

			const installName = skillName;
			const dest = join(resolveSkillsDir(agent), installName);
			if (existsSync(dest) && !force) {
				throw new Error(
					`"${installName}" is already installed. Run with --force to overwrite.`,
				);
			}
			setSkill(found);
			setResolvedVersion(version ?? found.version);
			setPhase("downloading");

			// Phase: downloading
			const buffer = version
				? await downloadSkillVersion(found.name, version)
				: await downloadSkill(found.id);
			setPhase("extracting");

			// Phase: extracting
			await extractSkill(buffer, dest);
			setPhase("done");
		})().catch((e: unknown) => {
			setError(e instanceof Error ? e.message : String(e));
			setPhase("error");
		});
	}, [skillName, author, version, agent, force]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 500);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	const isActive = phase !== "done" && phase !== "error";
	const label = agentLabel(agent);
	const displayName = author ? `${author}/${skillName}` : skillName;

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="skill install">
				<Step
					active={isActive}
					title={<Text bold>Installing {displayName}</Text>}
				>
					{phase === "searching" && <Text dimColor>Searching SkillHub...</Text>}
					{phase === "downloading" && skill != null && (
						<Text dimColor>
							Downloading {skill.name} v{resolvedVersion}...
						</Text>
					)}
					{phase === "extracting" && (
						<Text dimColor>
							Extracting to {label}/{skillName}/...
						</Text>
					)}
					{phase === "done" && (
						<Box flexDirection="column">
							<Text color="green">
								✓ Installed to {label}/{skillName}/
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
