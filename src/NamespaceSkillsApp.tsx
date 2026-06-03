import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { getNamespaceSkills, type NamespaceSkill } from "@/lib/skillhub.js";

type Phase = "loading" | "done" | "error";

function statusColor(status: NamespaceSkill["status"]): string {
	switch (status) {
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

interface Props {
	slug: string;
}

export function NamespaceSkillsApp({ slug }: Props) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [skills, setSkills] = useState<NamespaceSkill[]>([]);
	const [error, setError] = useState("");
	const didFetch = useRef(false);

	useEffect(() => {
		if (didFetch.current) return;
		didFetch.current = true;
		getNamespaceSkills(slug)
			.then((result) => {
				setSkills(result);
				setPhase("done");
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setPhase("error");
			});
	}, [slug]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 200);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag={`skill ns ${slug}`}>
				<Step
					active={phase === "loading"}
					title={
						<Text bold>
							Skills in <Text color="cyan">{slug}</Text>
						</Text>
					}
				>
					{phase === "loading" && (
						<Text dimColor>Loading from SkillHub...</Text>
					)}
					{phase === "done" && skills.length === 0 && (
						<Box flexDirection="column" gap={1}>
							<Text dimColor>No skills in this namespace yet.</Text>
							<Text dimColor>
								Upload one: codev skill upload {"<path>"} --namespace {slug}
							</Text>
						</Box>
					)}
					{phase === "done" && skills.length > 0 && (
						<Box flexDirection="column" gap={1}>
							<Text dimColor>
								{skills.length} skill{skills.length !== 1 ? "s" : ""}:
							</Text>
							{skills.map((s) => (
								<Box key={s.id} gap={2}>
									<Text bold color="cyan">
										{s.name}
									</Text>
									<Text dimColor>v{s.version}</Text>
									<Text color={statusColor(s.status)} dimColor>
										{s.status}
									</Text>
									{s.author && <Text dimColor>by @{s.author.username}</Text>}
								</Box>
							))}
						</Box>
					)}
					{phase === "error" && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
