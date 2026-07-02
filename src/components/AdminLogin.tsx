import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useRef, useState } from "react";
import { saveSkillhubCookie } from "@/lib/auth.js";
import { type SkillhubUser, skillhubSignIn } from "@/lib/skillhub.js";

interface AdminLoginProps {
	onDone: (user: SkillhubUser) => void;
	// Called after the final failed attempt (maxAttempts reached). The form
	// stops accepting Enter-to-retry at that point, so the caller can exit
	// non-zero. Optional — omit to keep retries unbounded.
	onFail?: (message: string) => void;
	// How many credential attempts before giving up. Default 3.
	maxAttempts?: number;
}

type FieldKey = "username" | "password";

const FIELDS: { key: FieldKey; label: string; mask: boolean }[] = [
	{ key: "username", label: "Username", mask: false },
	{ key: "password", label: "Password", mask: true },
];
const LABEL_WIDTH = Math.max(...FIELDS.map((f) => f.label.length));

// "input" accepts a fresh attempt (a failed sign-in below the cap drops
// straight back here with the fields cleared); "failed" is the terminal state
// after maxAttempts — no more retries.
type Phase = "input" | "submitting" | "failed";

// Interactive username/password form for `codev login --admin`. Only local
// ADMIN/SUPERADMIN accounts can use this — regular users are rejected
// server-side and must log in via SSO (`codev login`). On success it captures
// the skill-hub-session cookie and persists it via saveSkillhubCookie.
export function AdminLogin({
	onDone,
	onFail,
	maxAttempts = 3,
}: AdminLoginProps) {
	const [values, setValues] = useState<Record<FieldKey, string>>({
		username: "",
		password: "",
	});
	const [index, setIndex] = useState(0);
	const [phase, setPhase] = useState<Phase>("input");
	const [error, setError] = useState<string | null>(null);
	// Authoritative attempt count for the give-up decision (read inside the
	// async submit, so a ref rather than the render-only `attempts` mirror).
	const attemptsRef = useRef(0);
	const [attempts, setAttempts] = useState(0);

	const submit = useCallback(
		async (username: string, password: string) => {
			setPhase("submitting");
			try {
				const { cookie, user } = await skillhubSignIn(username, password);
				saveSkillhubCookie(cookie);
				onDone(user);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const used = attemptsRef.current + 1;
				attemptsRef.current = used;
				setAttempts(used);
				setError(msg);
				if (used >= maxAttempts) {
					// Out of attempts — freeze in the terminal state and hand the
					// failure up so the caller can exit non-zero.
					setPhase("failed");
					onFail?.(msg);
				} else {
					// Retry right away: clear the fields and drop back to the input
					// phase so the user can retype immediately — no Enter-to-retry gate.
					setValues({ username: "", password: "" });
					setIndex(0);
					setPhase("input");
				}
			}
		},
		[onDone, onFail, maxAttempts],
	);

	useInput(
		(input, key) => {
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
		{ isActive: phase === "input" },
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
					{phase === "input" && attempts > 0 && (
						<Text dimColor>{`  (attempt ${attempts} of ${maxAttempts})`}</Text>
					)}
					{phase === "failed" && (
						<Text
							dimColor
						>{`  (${maxAttempts} failed attempts — giving up)`}</Text>
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
