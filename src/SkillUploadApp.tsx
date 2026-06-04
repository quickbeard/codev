import { Box, Text, useApp } from "ink";
import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Step } from "@/components/Step.js";
import { SKILLHUB_REGISTRY } from "@/lib/const.js";
import { createZipFromPath } from "@/lib/skill-archive.js";
import { saveSkillMetadata, submitSkill, uploadSkill } from "@/lib/skillhub.js";

type Phase =
	| "preparing"
	| "uploading"
	| "saving"
	| "submitting"
	| "done"
	| "error";

interface Props {
	inputPath: string;
	namespace?: string;
	submit?: boolean;
}

export function SkillUploadApp({
	inputPath,
	namespace,
	submit = false,
}: Props) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("preparing");
	const [skillName, setSkillName] = useState("");
	const [zipSize, setZipSize] = useState("");
	const [finalStatus, setFinalStatus] = useState("");
	const [error, setError] = useState("");
	const didRun = useRef(false);

	useEffect(() => {
		if (didRun.current) return;
		didRun.current = true;

		(async () => {
			// Phase: preparing
			const { buffer, filename } = createZipFromPath(inputPath);
			const name = filename.replace(/\.zip$/i, "");
			setSkillName(name);
			const kb = (buffer.byteLength / 1024).toFixed(1);
			setZipSize(
				buffer.byteLength > 1024 * 1024
					? `${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`
					: `${kb} KB`,
			);
			setPhase("uploading");

			// Phase: uploading
			const skillId = await uploadSkill(buffer, filename, namespace);
			setPhase("saving");

			// Phase: saving metadata → DRAFT or PRIVATE
			await saveSkillMetadata(skillId);

			if (submit) {
				setPhase("submitting");
				await submitSkill(skillId);
				setFinalStatus("SUBMITTED");
			} else {
				setFinalStatus(namespace ? "PRIVATE" : "DRAFT");
			}

			setPhase("done");
		})().catch((e: unknown) => {
			setError(e instanceof Error ? e.message : String(e));
			setPhase("error");
		});
	}, [inputPath, namespace, submit]);

	useEffect(() => {
		if (phase === "done") setTimeout(() => exit(), 500);
		if (phase === "error") exit(new Error(error));
	}, [phase, error, exit]);

	const isActive = phase !== "done" && phase !== "error";

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="skill upload">
				<Step
					active={isActive}
					title={<Text bold>Uploading {skillName || inputPath}</Text>}
				>
					{phase === "preparing" && (
						<Text dimColor>Preparing skill package...</Text>
					)}
					{phase === "uploading" && (
						<Text dimColor>Uploading to SkillHub... ({zipSize})</Text>
					)}
					{phase === "saving" && <Text dimColor>Saving metadata...</Text>}
					{phase === "submitting" && (
						<Text dimColor>Submitting for admin review...</Text>
					)}
					{phase === "done" && finalStatus === "SUBMITTED" && (
						<Box flexDirection="column" gap={1}>
							<Text color="green">✓ Submitted for review</Text>
							<Text dimColor>
								An admin will review your skill. Run `codev skill my` to track
								status.
							</Text>
							<Text dimColor>{SKILLHUB_REGISTRY}</Text>
						</Box>
					)}
					{phase === "done" && finalStatus === "DRAFT" && (
						<Box flexDirection="column" gap={1}>
							<Text color="yellow">✓ Saved as Draft</Text>
							<Text dimColor>
								Visible only to you. Run `codev skill publish {skillName}` when
								ready to submit for review.
							</Text>
						</Box>
					)}
					{phase === "done" && finalStatus === "PRIVATE" && (
						<Box flexDirection="column" gap={1}>
							<Text color="magenta">✓ Saved as Private</Text>
							<Text dimColor>
								Visible to namespace members only. Run `codev skill publish{" "}
								{skillName}` to submit for public review.
							</Text>
						</Box>
					)}
					{phase === "error" &&
						(() => {
							const lines = error.split("\n");
							return (
								<Box flexDirection="column">
									<Text color="red">✗ {lines[0]}</Text>
									{lines.slice(1).map((line) => (
										<Text key={line} dimColor>
											{"  "}
											{line}
										</Text>
									))}
								</Box>
							);
						})()}
				</Step>
			</Frame>
		</Box>
	);
}
