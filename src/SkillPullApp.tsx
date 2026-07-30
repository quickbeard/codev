import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { stripControlChars } from "@/lib/sanitize.js";
import {
	formatInstallResult,
	type InstallLocation,
	type InstallResult,
	installResolvedSkill,
	skillsDirFor,
} from "@/lib/skill-install.js";
import { getSkillMeta, type SkillMeta } from "@/lib/skillhub.js";

interface SkillPullAppProps {
	target: string;
	force: boolean;
	json: boolean;
	// Reports success/failure so the caller can set the process exit code, then
	// the app exits on its own. Optional so tests can omit it.
	onDone?: (ok: boolean) => void;
}

type Phase = "resolving" | "select" | "installing" | "done" | "error";

const LOCATIONS: { key: InstallLocation; label: string }[] = [
	{ key: "current", label: "Current directory" },
	{ key: "global", label: "Global" },
];

export function SkillPullApp({
	target,
	force,
	json,
	onDone,
}: SkillPullAppProps) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("resolving");
	const [meta, setMeta] = useState<SkillMeta | null>(null);
	const [index, setIndex] = useState(0);
	const [result, setResult] = useState<InstallResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Signal the outcome, then unmount. exit() takes no error — the exit code is
	// carried by onDone — so waitUntilExit resolves cleanly either way.
	const finish = useCallback(
		(ok: boolean) => {
			onDone?.(ok);
			// Hold a successful frame briefly so it's readable; drop fast on error.
			setTimeout(() => exit(), ok ? 500 : 20);
		},
		[onDone, exit],
	);

	// Resolve the skill's real name up front so the prompt shows the name (never
	// a raw id) and the install dir is named after it.
	useEffect(() => {
		let cancelled = false;
		getSkillMeta(target)
			.then((m) => {
				if (cancelled) return;
				setMeta(m);
				setPhase("select");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				finish(false);
			});
		return () => {
			cancelled = true;
		};
	}, [target, finish]);

	const start = useCallback(
		async (location: InstallLocation) => {
			if (!meta) return;
			setPhase("installing");
			try {
				const r = await installResolvedSkill(meta, {
					rootDir: skillsDirFor(location),
					force,
				});
				setResult(r);
				setPhase("done");
				finish(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				finish(false);
			}
		},
		[meta, force, finish],
	);

	useInput(
		(_input, key) => {
			if (phase !== "select") return;
			if (key.upArrow) {
				setIndex((i) => (i === 0 ? LOCATIONS.length - 1 : i - 1));
			} else if (key.downArrow) {
				setIndex((i) => (i + 1) % LOCATIONS.length);
			} else if (key.return) {
				void start(LOCATIONS[index]?.key ?? "current");
			}
		},
		{ isActive: phase === "select" },
	);

	// Sanitize the hub-sourced name before rendering it to the terminal.
	const skillName = meta ? stripControlChars(meta.name) : null;
	const title = skillName ? `Install ${skillName} skill` : "Install skill";

	return (
		<Box flexDirection="column" paddingX={1} paddingBottom={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step active title={<Text bold>{title}</Text>}>
					{phase === "resolving" && (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{" Resolving skill..."}</Text>
						</Box>
					)}
					{phase === "select" && meta && (
						<Box flexDirection="column">
							<Text dimColor>{`Install ${skillName} to:`}</Text>
							{LOCATIONS.map((loc, i) => (
								<Text key={loc.key} color={i === index ? "cyan" : undefined}>
									{`${i === index ? "❯ " : "  "}${loc.label}`}
								</Text>
							))}
						</Box>
					)}
					{phase === "installing" && (
						<Box>
							<Text color="cyan">
								<Spinner />
							</Text>
							<Text>{" Installing..."}</Text>
						</Box>
					)}
					{phase === "done" && result && (
						<Text color={json ? undefined : "green"}>
							{formatInstallResult(result, json)}
						</Text>
					)}
					{phase === "error" && error && <Text color="red">{error}</Text>}
				</Step>
			</Frame>
		</Box>
	);
}
