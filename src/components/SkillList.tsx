import { Box, Text } from "ink";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import type { HubSkill } from "@/lib/skillhub.js";

interface Props {
	skills: HubSkill[];
	query?: string;
}

export function SkillList({ skills, query }: Props) {
	if (skills.length === 0) {
		return (
			<Text dimColor>No skills found{query ? ` for "${query}"` : ""}.</Text>
		);
	}

	return (
		<Box flexDirection="column" gap={1}>
			<Text dimColor>
				Found {skills.length} skill{skills.length !== 1 ? "s" : ""}
				{query ? ` for "${query}"` : ""}:
			</Text>
			{skills.map((skill) => (
				<Box key={skill.id} flexDirection="column">
					<Box gap={2}>
						<Text bold color="cyan">
							{skill.name}
						</Text>
						<Text dimColor>v{skill.version}</Text>
						{skill.author != null && (
							<Text dimColor>by {skill.author.name}</Text>
						)}
						<Text dimColor>↓ {skill.downloadCount}</Text>
					</Box>
					{skill.description != null && (
						<Text dimColor>
							{"  "}
							{skill.description}
						</Text>
					)}
				</Box>
			))}
			<Box marginTop={1} flexDirection="column">
				<Text dimColor>{"Run `codev skill install <name>` to install."}</Text>
				<Text dimColor>{SKILLHUB_REGISTRY}</Text>
			</Box>
		</Box>
	);
}
