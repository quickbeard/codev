import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { SkillList } from "@/components/SkillList.js";
import { Step } from "@/components/Step.js";
import { type HubSkill, searchSkills } from "@/lib/skillhub.js";

type Phase = "loading" | "done" | "error";

interface Props {
	query?: string;
}

export function SkillSearchApp({ query }: Props) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [skills, setSkills] = useState<HubSkill[]>([]);
	const [error, setError] = useState("");
	const didFetch = useRef(false);

	useEffect(() => {
		if (didFetch.current) return;
		didFetch.current = true;
		searchSkills(query)
			.then((result) => {
				setSkills(result);
				setPhase("done");
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setPhase("error");
			});
	}, [query]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 200);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="skill search">
				<Step
					active={phase === "loading"}
					title={<Text bold>Searching skills</Text>}
				>
					{phase === "loading" && (
						<Text dimColor>Fetching from SkillHub...</Text>
					)}
					{phase === "done" && <SkillList skills={skills} query={query} />}
					{phase === "error" && <Text color="red">Error: {error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
