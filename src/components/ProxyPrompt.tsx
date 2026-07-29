import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { normalizeProxyInput } from "@/lib/doctor.js";

interface ProxyPromptProps {
	/** Called with a normalized proxy URL, or null when the user skips. */
	onSubmit: (proxyUrl: string | null) => void;
	/**
	 * The proxy already in the environment, if any. Its presence changes the
	 * question from "do you need a proxy?" to "is this one wrong?", which is the
	 * more useful question once the network has failed *despite* a proxy.
	 */
	currentProxy?: string | null;
	readOnly?: boolean;
}

// Concrete forms, because "host:port" alone leaves real questions unanswered:
// does a hostname work, how do I pass a password, do I need http://. Each line
// exists to answer one of those.
const EXAMPLES: [string, string][] = [
	["10.60.129.1:3128", "IP and port"],
	["proxy.corp.vn:8080", "hostname and port"],
	["user:pass@10.60.129.1:3128", "proxy that needs a login"],
	["http://10.60.129.1:3128", "full URL (http:// is assumed if you omit it)"],
];

const EXAMPLE_WIDTH = Math.max(...EXAMPLES.map(([e]) => e.length));

/**
 * Single `host:port` field, offered whenever the network checks fail.
 *
 * Deliberately offered even when a proxy is already configured: "the proxy is
 * set, so the proxy is fine" was the wrong inference — a *wrong* proxy address
 * is one of the most likely reasons the checks failed at all, and suppressing
 * the prompt left that user with no way to try another one.
 *
 * Hand-rolled on `useInput` like ManualCredentials — the repo deliberately
 * carries no text-input dependency, and one optional field does not justify
 * adding one.
 */
export function ProxyPrompt({
	onSubmit,
	currentProxy = null,
	readOnly = false,
}: ProxyPromptProps) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitted, setSubmitted] = useState(false);

	useInput(
		(input, key) => {
			if (submitted) return;

			if (key.return) {
				const trimmed = value.trim();
				// Blank means "skip" — the failure stays recorded and the summary
				// still prints the setup instructions.
				if (!trimmed) {
					setSubmitted(true);
					onSubmit(null);
					return;
				}
				const url = normalizeProxyInput(trimmed);
				if (!url) {
					// Name the likely mistake. A bare number is both the most probable
					// slip against a "host:port" prompt and the one with the worst
					// silent failure, so it gets its own message.
					setError(
						/^\d+$/.test(trimmed)
							? `"${trimmed}" looks like just the port. Enter the host too, e.g. 10.0.0.1:${trimmed}`
							: "That doesn't look like a proxy address. Use host:port, e.g. 10.0.0.1:8080",
					);
					return;
				}
				setError(null);
				setSubmitted(true);
				onSubmit(url);
				return;
			}

			if (key.backspace || key.delete) {
				setValue((prev) => prev.slice(0, -1));
				return;
			}

			// Ignore control keys so escape sequences never leak into the field.
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;
			setValue((prev) => prev + input);
		},
		{ isActive: !readOnly && !submitted },
	);

	if (submitted) {
		return (
			<Text dimColor>
				{value.trim() ? `Retrying via ${value.trim()}…` : "Skipped."}
			</Text>
		);
	}

	return (
		<Box flexDirection="column">
			{currentProxy ? (
				<>
					<Text>
						{`The network checks failed even though a proxy is configured (${currentProxy}).`}
					</Text>
					<Text>
						{
							"If that address is wrong, enter the correct one and CoDev will re-run the checks with it."
						}
					</Text>
				</>
			) : (
				<Text>
					{
						"The network checks failed. If this machine reaches the internet through a proxy, enter it here and CoDev will re-run the checks with it applied."
					}
				</Text>
			)}
			<Text dimColor>
				{"Nothing is written to disk — this applies to this run only."}
			</Text>

			<Box flexDirection="column" marginTop={1}>
				<Text dimColor>{"Examples:"}</Text>
				{EXAMPLES.map(([example, note]) => (
					<Box key={example}>
						<Text dimColor>{"  "}</Text>
						<Box width={EXAMPLE_WIDTH + 2} flexShrink={0}>
							<Text color="cyan">{example}</Text>
						</Box>
						<Text dimColor>{note}</Text>
					</Box>
				))}
			</Box>

			<Box marginTop={1}>
				<Text>
					{currentProxy
						? "Proxy (host:port), or Enter to keep the current one: "
						: "Proxy (host:port), or Enter to skip: "}
				</Text>
				<Text color="cyan">{value}</Text>
				<Text color="cyan">▌</Text>
			</Box>
			{error && <Text color="red">{error}</Text>}
		</Box>
	);
}

export function proxyPromptTitle() {
	return <Text bold>{"Configure a proxy"}</Text>;
}
