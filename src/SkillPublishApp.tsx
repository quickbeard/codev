import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { getMySkills, submitSkill } from "@/lib/skillhub.js";

type Phase = "finding" | "submitting" | "done" | "error";

interface Props {
	name: string;
}

export function SkillPublishApp({ name }: Props) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("finding");
	const [error, setError] = useState("");
	const didRun = useRef(false);

	useEffect(() => {
		if (didRun.current) return;
		didRun.current = true;

		(async () => {
			// Phase: finding
			const skills = await getMySkills();
			const skill = skills.find(
				(s) => s.name.toLowerCase() === name.toLowerCase(),
			);
			if (!skill) {
				throw new Error(
					`Skill "${name}" not found. Run \`codev skill my\` to list your skills.`,
				);
			}
			const submittable: string[] = ["DRAFT", "PRIVATE", "REJECTED"];
			if (!submittable.includes(skill.status)) {
				throw new Error(
					`Cannot publish skill with status "${skill.status}". Only Draft, Private, or Rejected skills can be submitted.`,
				);
			}
			setPhase("submitting");

			// Phase: submitting
			await submitSkill(skill.id);
			setPhase("done");
		})().catch((e: unknown) => {
			setError(e instanceof Error ? e.message : String(e));
			setPhase("error");
		});
	}, [name]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 500);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	const isActive = phase !== "done" && phase !== "error";

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="skill publish">
				<Step active={isActive} title={<Text bold>Publishing {name}</Text>}>
					{phase === "finding" && <Text dimColor>Looking up skill...</Text>}
					{phase === "submitting" && (
						<Text dimColor>Submitting for admin review...</Text>
					)}
					{phase === "done" && (
						<Box flexDirection="column" gap={1}>
							<Text color="green">✓ Submitted for review</Text>
							<Text dimColor>
								An admin will review your skill and notify you when approved or
								rejected.
							</Text>
							<Text dimColor>Track status: codev skill my</Text>
						</Box>
					)}
					{phase === "error" && <Text color="red">✗ {error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
