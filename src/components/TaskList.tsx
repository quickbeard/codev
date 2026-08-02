import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n.js";
import { logError, logInfo, logWarn } from "@/lib/log.js";

// Three terminal outcomes for a task:
//   - `null` → succeeded silently (green ✓ "Installed pkg-x"). Key is
//     included in onDone's succeededKeys.
//   - `string` → hard failure (red ✗ "Failed to install pkg-x: <err>"). Key
//     is omitted from succeededKeys. Use for failures that must block this
//     row's downstream consumers.
//   - `{ warning }` → soft warning (yellow ▲ "Warning: …"). Key is still
//     included in succeededKeys — the task did *something* useful or the
//     failure is recoverable downstream. Used by the Continue extension/
//     plugin installs so a transient marketplace/network issue doesn't drop
//     the row from the survivor set.
export type TaskRunResult = string | null | { warning: string };

// Diagnostic-log mirror of a task row's terminal state, leveled to match the
// icon (✓ info, ▲ warn, ✗ error). Exported for tests.
export function logTaskResult(
	key: string,
	label: string,
	result: TaskRunResult,
): void {
	if (result === null) {
		logInfo(`task ok: ${label}`, {
			action: "task.result",
			outcome: "success",
			extra: { key, label },
		});
	} else if (typeof result === "string") {
		logError(`task failed: ${label}: ${result}`, {
			action: "task.result",
			outcome: "failure",
			extra: { key, label, error: result },
		});
	} else {
		logWarn(`task warning: ${label}: ${result.warning}`, {
			action: "task.result",
			extra: { key, label, warning: result.warning },
		});
	}
}

export interface TaskItem {
	key: string;
	label: string;
	run: () => Promise<TaskRunResult>;
}

// Which set of row messages this list speaks. It used to be a
// `{ infinitive, present, past }` struct that `rowText` substituted into English
// word order ("Failed to " + infinitive + " " + label) — a shape no other
// language can satisfy, since nothing outside English conjugates by slotting
// three principal parts into a fixed frame. Each state is now a complete
// sentence in the catalog, and this prop only picks which family to read.
export type TaskVerb = "install" | "update";

type Status = "pending" | "running" | "done" | "warned" | "failed";

interface Row {
	key: string;
	label: string;
	status: Status;
	error?: string;
	warning?: string;
}

interface TaskListProps {
	tasks: TaskItem[];
	verb: TaskVerb;
	// Receives the keys of every row that settled as `done` or `warned` —
	// i.e. did NOT hard-fail. An empty array means every task hard-failed.
	// The parent decides what to do with the survivor set (e.g. InstallApp
	// advances to Configure only with these tools; total failure parks).
	onDone: (succeededKeys: string[]) => void;
}

export function TaskList({ tasks, verb, onDone }: TaskListProps) {
	const [rows, setRows] = useState<Row[]>(() =>
		tasks.map((task) => ({
			key: task.key,
			label: task.label,
			status: "pending",
		})),
	);
	const hasRun = useRef(false);
	const hasReported = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		setRows((prev) => prev.map((r) => ({ ...r, status: "running" })));
		for (const [i, task] of tasks.entries()) {
			task.run().then((result) => {
				logTaskResult(task.key, task.label, result);
				setRows((prev) =>
					prev.map((r, idx) => {
						if (idx !== i) return r;
						if (result === null) return { ...r, status: "done" };
						if (typeof result === "string") {
							return { ...r, status: "failed", error: result };
						}
						return { ...r, status: "warned", warning: result.warning };
					}),
				);
			});
		}
	}, [tasks]);

	// Fire onDone only after React has committed the terminal status for every
	// task. Calling onDone inside the run-promise chain races the final commit:
	// the parent's exit() can unmount the tree before Ink flushes the last
	// row to the terminal.
	useEffect(() => {
		if (hasReported.current) return;
		if (rows.length === 0) return;
		const allSettled = rows.every(
			(r) =>
				r.status === "done" || r.status === "failed" || r.status === "warned",
		);
		if (!allSettled) return;
		hasReported.current = true;
		// `warned` rows count as success — they didn't accomplish the install
		// but they didn't fatally fail either; the parent (e.g. InstallApp)
		// still wants their keys in the survivor set so Configure runs for
		// them.
		onDone(rows.filter((r) => r.status !== "failed").map((r) => r.key));
	}, [rows, onDone]);

	return (
		<Box flexDirection="column">
			{rows.map((row) => (
				<TaskRow key={row.key} row={row} verb={verb} />
			))}
		</Box>
	);
}

function TaskRow({ row, verb }: { row: Row; verb: TaskVerb }) {
	const color = row.status === "warned" ? "yellow" : undefined;
	// Embed the icon-text gap as a literal space in the Text payload rather
	// than as a `marginRight` between flex children — long warnings that
	// wrap can otherwise render the gap inconsistently across rows (visible
	// as `▲Warning:` on one row but `▲ Warning:` on another in the same
	// install run).
	return (
		<Box>
			<StatusIcon status={row.status} />
			<Text color={color}>{` ${rowText(row, verb)}`}</Text>
		</Box>
	);
}

function rowText(row: Row, verb: TaskVerb): string {
	// `row.label` is a package or product name and is interpolated, never
	// translated. The template literals resolve to real MessageKey unions, so a
	// catalog missing one verb's messages is a compile error rather than a
	// runtime fallback.
	switch (row.status) {
		case "running":
			return t(`tasklist.${verb}.running`, { label: row.label });
		case "done":
			return t(`tasklist.${verb}.done`, { label: row.label });
		case "warned":
			// Don't claim the task completed ("Installed X (warning: …)") when
			// the install actually didn't run — the row would lie. Just surface
			// the warning; the message itself names the editor / CLI involved.
			return t("tasklist.warning", {
				warning: row.warning ?? t("tasklist.unknown"),
			});
		case "failed":
			return t(`tasklist.${verb}.failed`, {
				label: row.label,
				error: row.error ?? t("tasklist.unknown_error"),
			});
		default:
			return row.label;
	}
}

function StatusIcon({ status }: { status: Status }) {
	if (status === "running") {
		return (
			<Text color="cyan">
				<Spinner />
			</Text>
		);
	}
	if (status === "done") return <Text color="green">✓</Text>;
	// `▲` (U+25B2, Geometric Shapes) renders reliably single-cell in
	// monospace fonts — same East-Asian-Ambiguous bucket as `✓`/`✗`.
	// `⚠` (U+26A0) is in the emoji bucket on most modern fonts and renders
	// ~2 cells wide, which knocks the row out of alignment with the others.
	if (status === "warned") return <Text color="yellow">▲</Text>;
	if (status === "failed") return <Text color="red">✗</Text>;
	return <Text dimColor>○</Text>;
}
