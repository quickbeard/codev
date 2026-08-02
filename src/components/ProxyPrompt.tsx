import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { normalizeProxyInput } from "@/lib/doctor.js";
import { t } from "@/lib/i18n.js";

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
const EXAMPLES = [
	["10.60.129.1:3128", "proxy_prompt.example.ip_port"],
	["proxy.corp.vn:8080", "proxy_prompt.example.host_port"],
	["user:pass@10.60.129.1:3128", "proxy_prompt.example.with_login"],
	["http://10.60.129.1:3128", "proxy_prompt.example.full_url"],
] as const;

// Measures the addresses, which are literals in every locale — only the note
// beside each one is translated — so this can stay a module constant.
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
							? t("proxy_prompt.error.port_only", { input: trimmed })
							: t("proxy_prompt.error.invalid"),
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
				{value.trim()
					? t("proxy_prompt.retrying", { proxy: value.trim() })
					: t("proxy_prompt.skipped")}
			</Text>
		);
	}

	return (
		<Box flexDirection="column">
			{currentProxy ? (
				<>
					<Text>
						{t("proxy_prompt.failed_with_proxy", { proxy: currentProxy })}
					</Text>
					<Text>{t("proxy_prompt.wrong_address")}</Text>
				</>
			) : (
				<Text>{t("proxy_prompt.failed_no_proxy")}</Text>
			)}
			<Text dimColor>{t("proxy_prompt.not_written")}</Text>

			<Box flexDirection="column" marginTop={1}>
				<Text dimColor>{t("proxy_prompt.examples")}</Text>
				{EXAMPLES.map(([example, noteKey]) => (
					<Box key={example}>
						<Text dimColor>{"  "}</Text>
						<Box width={EXAMPLE_WIDTH + 2} flexShrink={0}>
							<Text color="cyan">{example}</Text>
						</Box>
						<Text dimColor>{t(noteKey)}</Text>
					</Box>
				))}
			</Box>

			<Box marginTop={1}>
				<Text>
					{currentProxy
						? t("proxy_prompt.field.keep")
						: t("proxy_prompt.field.skip")}
				</Text>
				<Text color="cyan">{value}</Text>
				<Text color="cyan">▌</Text>
			</Box>
			{error && <Text color="red">{error}</Text>}
		</Box>
	);
}

export function proxyPromptTitle() {
	return <Text bold>{t("proxy_prompt.title")}</Text>;
}
