import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import {
	getUserProfile,
	getUserSkills,
	type UserProfile,
	type UserSkill,
} from "@/lib/skillhub.js";

type Phase = "loading" | "done" | "error";

interface Props {
	username: string;
}

export function SkillUserApp({ username }: Props) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [skills, setSkills] = useState<UserSkill[]>([]);
	const [error, setError] = useState("");
	const didFetch = useRef(false);

	useEffect(() => {
		if (didFetch.current) return;
		didFetch.current = true;
		Promise.all([getUserProfile(username), getUserSkills(username)])
			.then(([p, s]) => {
				setProfile(p);
				setSkills(s);
				setPhase("done");
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setPhase("error");
			});
	}, [username]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 200);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	const displayName = profile?.firstName
		? `${profile.firstName}${profile.lastName ? ` ${profile.lastName}` : ""}`
		: username;

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag={`skill user ${username}`}>
				<Step
					active={phase === "loading"}
					title={<Text bold>@{username}</Text>}
				>
					{phase === "loading" && (
						<Text dimColor>Loading from SkillHub...</Text>
					)}
					{phase === "done" && profile && (
						<Box flexDirection="column" gap={1}>
							<Box gap={2}>
								<Text bold>{displayName}</Text>
								{profile.jobTitle && <Text dimColor>{profile.jobTitle}</Text>}
							</Box>
							{(profile.centerName || profile.companyName) && (
								<Text dimColor>
									{[profile.centerName, profile.companyName]
										.filter(Boolean)
										.join(" · ")}
								</Text>
							)}
							<Box gap={3}>
								<Text>
									<Text bold color="cyan">
										{profile.stats.publicSkills}
									</Text>{" "}
									<Text dimColor>skills</Text>
								</Text>
								<Text>
									<Text bold color="cyan">
										{profile.stats.totalDownloads}
									</Text>{" "}
									<Text dimColor>downloads</Text>
								</Text>
								<Text>
									<Text bold color="cyan">
										{profile.stats.totalStars}
									</Text>{" "}
									<Text dimColor>stars</Text>
								</Text>
							</Box>
							{skills.length > 0 && (
								<Box flexDirection="column" marginTop={1}>
									<Text dimColor bold>
										Published skills:
									</Text>
									{skills.map((s) => (
										<Box key={s.id} gap={2} marginLeft={2}>
											<Text color="cyan">{s.name}</Text>
											<Text dimColor>v{s.version}</Text>
											<Text dimColor>★ {s.stars}</Text>
											<Text dimColor>↓ {s.downloadCount}</Text>
										</Box>
									))}
								</Box>
							)}
							{skills.length === 0 && (
								<Text dimColor>No public skills yet.</Text>
							)}
							<Box marginTop={1}>
								<Text dimColor>
									{SKILLHUB_REGISTRY}/profile/{username}
								</Text>
							</Box>
						</Box>
					)}
					{phase === "error" && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
