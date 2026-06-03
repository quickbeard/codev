import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import { getMySkills, type MySkill, type SkillStatus } from "@/lib/skillhub.js";

type Phase = "loading" | "done" | "error";

function statusColor(s: SkillStatus): string {
	switch (s) {
		case "PUBLIC":
			return "green";
		case "SUBMITTED":
			return "cyan";
		case "REJECTED":
			return "red";
		case "PRIVATE":
			return "magenta";
		case "DRAFT":
		case "PENDING":
			return "yellow";
		default:
			return "gray";
	}
}

function statusLabel(s: SkillStatus): string {
	switch (s) {
		case "PUBLIC":
			return "Published";
		case "SUBMITTED":
			return "Under Review";
		case "REJECTED":
			return "Rejected";
		case "PRIVATE":
			return "Private";
		case "DRAFT":
			return "Draft";
		case "PENDING":
			return "Pending";
		default:
			return s;
	}
}

function SkillRow({ skill }: { skill: MySkill }) {
	const rejection = skill.reviews.find((r) => r.action === "REJECT");
	return (
		<Box flexDirection="column">
			<Box gap={2}>
				<Text bold color="cyan">
					{skill.name}
				</Text>
				<Text dimColor>v{skill.version}</Text>
				<Text color={statusColor(skill.status)} bold>
					{statusLabel(skill.status)}
				</Text>
			</Box>
			{rejection?.feedback && (
				<Box marginLeft={2}>
					<Text color="red" dimColor>
						Feedback: {rejection.feedback}
					</Text>
				</Box>
			)}
		</Box>
	);
}

export function MySkillsApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [skills, setSkills] = useState<MySkill[]>([]);
	const [error, setError] = useState("");
	const didFetch = useRef(false);

	useEffect(() => {
		if (didFetch.current) return;
		didFetch.current = true;
		getMySkills()
			.then((result) => {
				setSkills(result);
				setPhase("done");
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setPhase("error");
			});
	}, []);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 200);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="skill my">
				<Step active={phase === "loading"} title={<Text bold>My skills</Text>}>
					{phase === "loading" && (
						<Text dimColor>Loading from SkillHub...</Text>
					)}
					{phase === "done" && skills.length === 0 && (
						<Box flexDirection="column" gap={1}>
							<Text dimColor>You have no skills yet.</Text>
							<Text dimColor>Upload one: codev skill upload {"<path>"}</Text>
						</Box>
					)}
					{phase === "done" && skills.length > 0 && (
						<Box flexDirection="column" gap={1}>
							{skills.map((s) => (
								<SkillRow key={s.id} skill={s} />
							))}
							<Box marginTop={1}>
								<Text dimColor>{SKILLHUB_REGISTRY}</Text>
							</Box>
						</Box>
					)}
					{phase === "error" && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
