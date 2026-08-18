import { Box, Text } from "ink";
import type { RequestRecord } from "@/lib/log.js";
import type { CommandRecord } from "@/lib/npm.js";

interface ActivityLogProps {
	/** Every child process the run spawned, in order. */
	commands: CommandRecord[];
	/** Every HTTP request the run made, in order. */
	requests: RequestRecord[];
}

/**
 * The two run-wide inventories `codevhub doctor` prints before its verdict:
 * everything it executed on the user's machine, and every endpoint it touched.
 *
 * These do not replace the per-check activity lines — those answer "why did
 * THIS check fail?". These answer the two questions a reader has about the
 * command as a whole: "what did you just run on my machine?" (a fair question
 * for a diagnostic tool, and one that should not require reading the source)
 * and "which hosts do I have to allow-list?". On a corporate network the second
 * is the more useful half, and it is the half the npm-only list never covered:
 * the connection tests to the backend, the analysis backend and the gateway
 * never touch `execAsync`.
 *
 * The same two lists go into the report file under `commands` and `requests`.
 */
export function ActivityLog({ commands, requests }: ActivityLogProps) {
	if (commands.length === 0 && requests.length === 0) return null;

	return (
		<Box flexDirection="column">
			{commands.length > 0 && (
				<Box flexDirection="column">
					<Text bold>{"Commands run"}</Text>
					{commands.map((c, i) => (
						<Row
							key={`cmd-${i.toString()}`}
							ok={c.ok}
							text={c.command}
							durationMs={c.durationMs}
						/>
					))}
				</Box>
			)}
			{requests.length > 0 && (
				<Box flexDirection="column" marginTop={commands.length > 0 ? 1 : 0}>
					<Text bold>{"Endpoints contacted"}</Text>
					{requests.map((r, i) => (
						<Row
							key={`req-${i.toString()}`}
							// Scored on REACHABILITY, not 2xx. Several of these endpoints
							// answer 401 by design — an unauthenticated probe is supposed
							// to be rejected — and scoring on `r.ok` painted those red
							// directly under check rows that correctly called them a pass.
							// What this section reports is whether the network let us
							// through at all, so any response, including a refusal, is a
							// reached endpoint; only "nothing came back" is a failure.
							ok={r.status !== null}
							text={`${r.method} ${r.url} → ${r.status ?? "no response"}`}
							durationMs={r.durationMs}
						/>
					))}
				</Box>
			)}
		</Box>
	);
}

function Row({
	ok,
	text,
	durationMs,
}: {
	ok: boolean;
	text: string;
	durationMs: number;
}) {
	return (
		<Box>
			<Text color={ok ? "green" : "red"}>{ok ? "✓" : "✗"}</Text>
			<Text dimColor>{` ${text}  (${durationMs.toString()}ms)`}</Text>
		</Box>
	);
}
