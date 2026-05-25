import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";

// Three terminal outcomes for a task:
//   - `null` → succeeded silently (green ✓ "Installed pkg-x")
//   - `string` → hard failure (red ✗ "Failed to install pkg-x: <err>"), flips
//     onDone(success=false). Use for failures that must block the flow.
//   - `{ warning }` → soft warning (yellow ⚠ "Installed pkg-x (warning: …)"),
//     onDone(success=true). The task did *something* useful or the failure
//     is recoverable downstream — used by the Continue extension/plugin
//     installs so a transient marketplace/network issue doesn't abort the
//     `codev install` flow before the YAML config gets written.
export type TaskRunResult = string | null | { warning: string };

export interface TaskItem {
	key: string;
	label: string;
	run: () => Promise<TaskRunResult>;
}

export interface TaskVerb {
	// e.g. { infinitive: "install", present: "Installing", past: "Installed" }
	infinitive: string;
	present: string;
	past: string;
}

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
	onDone: (success: boolean) => void;
}

export function TaskList({ tasks, verb, onDone }: TaskListProps) {
	const [rows, setRows] = useState<Row[]>(() =>
		tasks.map((t) => ({ key: t.key, label: t.label, status: "pending" })),
	);
	const hasRun = useRef(false);
	const hasReported = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		setRows((prev) => prev.map((r) => ({ ...r, status: "running" })));
		for (const [i, task] of tasks.entries()) {
			task.run().then((result) => {
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
		// still wants to advance to Configure.
		onDone(rows.every((r) => r.status !== "failed"));
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
	return (
		<Box>
			<Box marginRight={1}>
				<StatusIcon status={row.status} />
			</Box>
			<Text color={color}>{rowText(row, verb)}</Text>
		</Box>
	);
}

function rowText(row: Row, verb: TaskVerb): string {
	switch (row.status) {
		case "running":
			return `${verb.present} ${row.label}...`;
		case "done":
			return `${verb.past} ${row.label}`;
		case "warned":
			// Don't claim the task completed ("Installed X (warning: …)") when
			// the install actually didn't run — the row would lie. Just surface
			// the warning; the message itself names the editor / CLI involved.
			return `Warning: ${row.warning ?? "unknown"}`;
		case "failed":
			return `Failed to ${verb.infinitive} ${row.label}: ${row.error ?? "unknown error"}`;
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
