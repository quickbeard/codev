import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import { getMyNamespaces, type HubNamespace } from "@/lib/skillhub.js";

type Phase = "loading" | "done" | "error";

function roleColor(role: HubNamespace["userRole"]): string {
	switch (role) {
		case "OWNER":
			return "cyan";
		case "ADMIN":
			return "cyan";
		case "MEMBER":
			return "white";
		default:
			return "gray";
	}
}

function nsStatusColor(status: HubNamespace["status"]): string {
	switch (status) {
		case "ACTIVE":
			return "green";
		case "FROZEN":
			return "yellow";
		default:
			return "gray";
	}
}

export function NamespacesApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [namespaces, setNamespaces] = useState<HubNamespace[]>([]);
	const [error, setError] = useState("");
	const didFetch = useRef(false);

	useEffect(() => {
		if (didFetch.current) return;
		didFetch.current = true;
		getMyNamespaces()
			.then((result) => {
				setNamespaces(result);
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
			<Frame tag="skill namespaces">
				<Step
					active={phase === "loading"}
					title={<Text bold>My namespaces</Text>}
				>
					{phase === "loading" && (
						<Text dimColor>Loading from SkillHub...</Text>
					)}
					{phase === "done" && namespaces.length === 0 && (
						<Text dimColor>You have no namespaces yet.</Text>
					)}
					{phase === "done" && namespaces.length > 0 && (
						<Box flexDirection="column" gap={1}>
							{namespaces.map((ns) => (
								<Box key={ns.id} gap={2}>
									<Text bold color="cyan">
										{ns.slug}
									</Text>
									<Text dimColor>
										{ns.skillCount} skill{ns.skillCount !== 1 ? "s" : ""}
									</Text>
									<Text color={nsStatusColor(ns.status)} dimColor>
										{ns.status}
									</Text>
									<Text color={roleColor(ns.userRole)} dimColor>
										{ns.userRole}
									</Text>
								</Box>
							))}
							<Box marginTop={1}>
								<Text dimColor>View skills: codev skill ns {"<slug>"}</Text>
							</Box>
							<Text dimColor>{SKILLHUB_REGISTRY}</Text>
						</Box>
					)}
					{phase === "error" && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
