import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { getLeaderboard, type Leaderboard } from "@/lib/skillhub.js";

type Phase = "loading" | "done" | "error";

const LIMIT = 5;

export function LeaderboardApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [data, setData] = useState<Leaderboard | null>(null);
	const [error, setError] = useState("");
	const didFetch = useRef(false);

	useEffect(() => {
		if (didFetch.current) return;
		didFetch.current = true;
		getLeaderboard()
			.then((result) => {
				setData(result);
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
			<Frame tag="skill leaderboard">
				<Step
					active={phase === "loading"}
					title={<Text bold>Leaderboard</Text>}
				>
					{phase === "loading" && (
						<Text dimColor>Loading from SkillHub...</Text>
					)}
					{phase === "done" && data && (
						<Box flexDirection="column" gap={2}>
							{/* Trending */}
							<Box flexDirection="column">
								<Text bold color="yellow">
									Trending this week
								</Text>
								{data.trending.slice(0, LIMIT).map((s, i) => (
									<Box key={s.id} gap={2} marginLeft={1}>
										<Text dimColor>{i + 1}.</Text>
										<Text color="cyan">{s.name}</Text>
										<Text dimColor>★ {s.stars}</Text>
										<Text dimColor>↓ {s.downloadCount}</Text>
										{s.author && <Text dimColor>@{s.author.username}</Text>}
									</Box>
								))}
							</Box>

							{/* Top Rated */}
							<Box flexDirection="column">
								<Text bold color="green">
									Top rated
								</Text>
								{data.topRated.slice(0, LIMIT).map((s, i) => (
									<Box key={s.id} gap={2} marginLeft={1}>
										<Text dimColor>{i + 1}.</Text>
										<Text color="cyan">{s.name}</Text>
										<Text color="yellow">★ {s.stars}</Text>
										<Text dimColor>↓ {s.downloadCount}</Text>
										{s.author && <Text dimColor>@{s.author.username}</Text>}
									</Box>
								))}
							</Box>

							{/* Most Downloaded */}
							<Box flexDirection="column">
								<Text bold color="cyan">
									Most downloaded
								</Text>
								{data.mostDownloaded.slice(0, LIMIT).map((s, i) => (
									<Box key={s.id} gap={2} marginLeft={1}>
										<Text dimColor>{i + 1}.</Text>
										<Text color="cyan">{s.name}</Text>
										<Text dimColor>★ {s.stars}</Text>
										<Text color="cyan">↓ {s.downloadCount}</Text>
										{s.author && <Text dimColor>@{s.author.username}</Text>}
									</Box>
								))}
							</Box>

							{/* Top Contributors */}
							<Box flexDirection="column">
								<Text bold color="magenta">
									Top contributors
								</Text>
								{data.contributors.slice(0, LIMIT).map((c, i) => (
									<Box key={c.authorId} gap={2} marginLeft={1}>
										<Text dimColor>{i + 1}.</Text>
										<Text color="cyan">@{c.username}</Text>
										{c.deptName && <Text dimColor>{c.deptName}</Text>}
										<Text dimColor>
											{c.skillCount} skill{c.skillCount !== 1 ? "s" : ""}
										</Text>
										<Text dimColor>★ {c.totalStars}</Text>
										<Text dimColor>↓ {c.totalDownloads}</Text>
									</Box>
								))}
							</Box>

							<Box marginTop={1}>
								<Text dimColor>
									codev skill user {"<username>"} — view a contributor's profile
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
