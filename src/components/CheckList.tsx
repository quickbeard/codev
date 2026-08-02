import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { CheckOutcome, CheckStatus, Diagnosis } from "@/lib/doctor.js";
import { t, tCount } from "@/lib/i18n.js";

interface CheckListProps {
	/** Labels of checks that have not produced an outcome yet, in order. */
	pending: string[];
	outcomes: CheckOutcome[];
	/** The label currently executing, rendered with a spinner. */
	running?: string | null;
	/**
	 * When true, passing rows collapse to a single summary line. Used by the
	 * install pre-flight, where a clean environment should cost one line —
	 * `codevhub doctor` itself always shows every row.
	 */
	collapsePasses?: boolean;
}

/**
 * Doctor's row renderer.
 *
 * Deliberately a sibling of TaskList rather than an extension of it: TaskList's
 * rowText is phrased entirely around installing things ("Installed X", "Failed
 * to install X"), and a check row needs a detail line plus, on failure, a full
 * multi-part diagnosis. Sharing the icon vocabulary (✓ ▲ ✗ ○) is the part that
 * matters for consistency, and that is duplicated intentionally — the ▲/⚠ width
 * note in TaskList applies here too.
 */
export function CheckList({
	pending,
	outcomes,
	running,
	collapsePasses = false,
}: CheckListProps) {
	const passes = outcomes.filter((o) => o.status === "pass");
	const shown = collapsePasses
		? outcomes.filter((o) => o.status !== "pass")
		: outcomes;

	return (
		<Box flexDirection="column">
			{collapsePasses && passes.length > 0 && (
				<Box>
					<Text color="green">✓</Text>
					<Text dimColor>
						{` ${tCount("checklist.env_passed", passes.length)}`}
					</Text>
				</Box>
			)}
			{shown.map((outcome) => (
				<CheckRow key={outcome.key} outcome={outcome} />
			))}
			{running && (
				<Box>
					<Text color="cyan">
						<Spinner />
					</Text>
					<Text>{` ${running}...`}</Text>
				</Box>
			)}
			{pending.map((label) => (
				<Box key={label}>
					<Text dimColor>○</Text>
					<Text dimColor>{` ${label}`}</Text>
				</Box>
			))}
		</Box>
	);
}

function StatusIcon({ status }: { status: CheckStatus }) {
	if (status === "pass") return <Text color="green">✓</Text>;
	// `▲` (U+25B2) renders single-cell in monospace fonts; `⚠` (U+26A0) sits in
	// the emoji bucket and renders ~2 cells wide, breaking row alignment.
	if (status === "warn") return <Text color="yellow">▲</Text>;
	if (status === "fail") return <Text color="red">✗</Text>;
	return <Text dimColor>–</Text>;
}

function CheckRow({ outcome }: { outcome: CheckOutcome }) {
	const color =
		outcome.status === "fail"
			? "red"
			: outcome.status === "warn"
				? "yellow"
				: undefined;
	return (
		<Box flexDirection="column">
			<Box>
				<StatusIcon status={outcome.status} />
				<Text color={color}>{` ${outcome.label}`}</Text>
			</Box>
			<Box paddingLeft={2}>
				<Text dimColor>{outcome.detail}</Text>
			</Box>
			{/* Failures expand in place. There is no --verbose flag on purpose:
			    explaining the failure IS the command, and a user who has to
			    re-run with a flag to find out why has already been failed once. */}
			{outcome.status === "fail" && outcome.diagnosis && (
				<DiagnosisBlock diagnosis={outcome.diagnosis} />
			)}
			{/* Warnings carry their fix inline; they have no diagnosis block. */}
			{outcome.status === "warn" && outcome.fix && (
				<Box paddingLeft={2} flexDirection="column">
					{outcome.fix.split("\n").map((line, i) => (
						<Text key={`warn-${outcome.key}-${i.toString()}`} color="yellow">
							{line}
						</Text>
					))}
				</Box>
			)}
			{/* What this check actually ran, under the check that ran it —
			    "what is this doing on my machine?" answered in place rather
			    than in a separate list the reader has to correlate.
			    Last, deliberately: status, then what, then what to do, then the
			    evidence. Putting it above the fix pushed the one actionable line
			    down the screen. No status icon either — the row's own icon is the
			    verdict, and marking an expected 401 red here would contradict it. */}
			{outcome.activity?.map((a, i) => (
				<Box key={`act-${outcome.key}-${i.toString()}`} paddingLeft={2}>
					<Text dimColor>{`↳ ${a.detail}  (${a.durationMs}ms)`}</Text>
				</Box>
			))}
		</Box>
	);
}

const FIELD_KEYS = [
	"checklist.field.what",
	"checklist.field.cause",
	"checklist.field.fix",
	"checklist.field.context",
	"checklist.field.raw",
] as const;

/**
 * Width of the diagnosis label gutter, derived from the active locale rather
 * than the hard-coded 15 this used to be — every one of these labels is longer
 * in some language than in English, and an under-sized `width` leaves the column
 * ragged (the box has flexShrink={0}, so the label wraps inside it instead of
 * overflowing).
 *
 * `.length` is the right measure while the shipped locales are Latin-script:
 * Vietnamese is precomposed NFC and single-width. A CJK locale would need a real
 * `stringWidth()` — Ink carries one transitively — since those characters are
 * two cells wide.
 */
function labelWidth(): number {
	return Math.max(...FIELD_KEYS.map((key) => t(key).length)) + 2;
}

function Field({ name, children }: { name: string; children: string[] }) {
	if (children.length === 0) return null;
	const width = labelWidth();
	return (
		<Box flexDirection="column">
			{children.map((line, i) => (
				<Box key={`${name}-${i.toString()}`}>
					<Box width={width} flexShrink={0}>
						<Text dimColor bold>
							{i === 0 ? name : ""}
						</Text>
					</Box>
					<Box flexGrow={1}>
						<Text>{line}</Text>
					</Box>
				</Box>
			))}
		</Box>
	);
}

function DiagnosisBlock({ diagnosis }: { diagnosis: Diagnosis }) {
	return (
		<Box flexDirection="column" paddingLeft={2} marginTop={1}>
			{/* The field *labels* are translated; the diagnosis prose they carry
			    comes from lib/doctor.ts and is deliberately still English. */}
			<Field name={t("checklist.field.what")}>{[diagnosis.what]}</Field>
			<Field name={t("checklist.field.cause")}>{[diagnosis.cause]}</Field>
			<Field name={t("checklist.field.fix")}>{diagnosis.fix.split("\n")}</Field>
			<Field name={t("checklist.field.context")}>{diagnosis.context}</Field>
			<Field name={t("checklist.field.raw")}>{diagnosis.raw}</Field>
		</Box>
	);
}
