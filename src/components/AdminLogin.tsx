import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useState } from "react";
import { saveSkillhubCookie } from "@/lib/auth.js";
import { type SkillhubUser, skillhubSignIn } from "@/lib/skillhub.js";

interface AdminLoginProps {
	onDone: (user: SkillhubUser) => void;
}

type FieldKey = "username" | "password";

const FIELDS: { key: FieldKey; label: string; mask: boolean }[] = [
	{ key: "username", label: "Username", mask: false },
	{ key: "password", label: "Password", mask: true },
];
const LABEL_WIDTH = Math.max(...FIELDS.map((f) => f.label.length));

type Phase = "input" | "submitting" | "error";

// Interactive username/password form for `codev login --admin`. Only local
// ADMIN/SUPERADMIN accounts can use this — regular users are rejected
// server-side and must log in via SSO (`codev login`). On success it captures
// the skill-hub-session cookie and persists it via saveSkillhubCookie.
export function AdminLogin({ onDone }: AdminLoginProps) {
	const [values, setValues] = useState<Record<FieldKey, string>>({
		username: "",
		password: "",
	});
	const [index, setIndex] = useState(0);
	const [phase, setPhase] = useState<Phase>("input");
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(
		async (username: string, password: string) => {
			setPhase("submitting");
			try {
				const { cookie, user } = await skillhubSignIn(username, password);
				saveSkillhubCookie(cookie);
				onDone(user);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
			}
		},
		[onDone],
	);

	useInput(
		(input, key) => {
			// After a failed sign-in, Enter clears the form for a fresh attempt.
			if (phase === "error") {
				if (key.return) {
					setValues({ username: "", password: "" });
					setIndex(0);
					setError(null);
					setPhase("input");
				}
				return;
			}
			if (phase !== "input") return;

			const current = FIELDS[index];
			if (!current) return;

			if (key.return) {
				// Trim the username (paste can carry stray whitespace); never touch
				// the password — leading/trailing spaces can be significant.
				const raw = values[current.key];
				const value = current.key === "username" ? raw.trim() : raw;
				if (!value) {
					setError(`${current.label} is required`);
					return;
				}
				setError(null);
				if (index < FIELDS.length - 1) {
					setIndex(index + 1);
					return;
				}
				void submit(values.username.trim(), values.password);
				return;
			}

			if (key.backspace || key.delete) {
				setValues((prev) => ({
					...prev,
					[current.key]: prev[current.key].slice(0, -1),
				}));
				return;
			}

			// Ignore control keys so arrows/tab/escape don't leak escape sequences.
			if (key.ctrl || key.meta || key.escape) return;
			if (!input) return;

			const cleaned = input.replace(/[\r\n]/g, "");
			if (!cleaned) return;

			setValues((prev) => ({
				...prev,
				[current.key]: prev[current.key] + cleaned,
			}));
		},
		{ isActive: phase === "input" || phase === "error" },
	);

	if (phase === "submitting") {
		return (
			<Box>
				<Text color="cyan">
					<Spinner />
				</Text>
				<Text>{" Signing in..."}</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{FIELDS.map((field, i) => {
				const isActive = phase === "input" && i === index;
				const value = values[field.key];
				const shown = field.mask ? "•".repeat(value.length) : value;
				const label = field.label.padEnd(LABEL_WIDTH, " ");
				return (
					<Box key={field.key}>
						<Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
							{`${label}: `}
						</Text>
						<Text>{shown}</Text>
						{isActive && <Text color="cyan">▌</Text>}
					</Box>
				);
			})}
			{error && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
					{phase === "error" && (
						<Text dimColor>{"  (press Enter to retry)"}</Text>
					)}
				</Box>
			)}
			{phase === "input" && (
				<Box marginTop={1}>
					<Text dimColor>
						{
							"Only ADMIN/SUPERADMIN accounts can sign in here — regular users use `codev login`."
						}
					</Text>
				</Box>
			)}
		</Box>
	);
}

export function adminLoginTitle() {
	return <Text bold>{"Admin login"}</Text>;
}
