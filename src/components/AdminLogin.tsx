import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useRef, useState } from "react";
import { saveSkillhubCookie } from "@/lib/auth.js";
import { t } from "@/lib/i18n.js";
import { type SkillhubUser, skillhubSignIn } from "@/lib/skillhub.js";
import { describeNetworkError } from "@/lib/tls.js";

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

// Labels are looked up per render rather than baked into a module constant —
// see the same note in ManualCredentials.
const FIELDS = [
	{
		key: "username" as FieldKey,
		labelKey: "admin_login.field.username",
		mask: false,
	},
	{
		key: "password" as FieldKey,
		labelKey: "admin_login.field.password",
		mask: true,
	},
] as const;

// "input" accepts a fresh attempt (a failed sign-in below the cap drops
// straight back here with the fields cleared); "failed" is the terminal state
// after maxAttempts — no more retries.
type Phase = "input" | "submitting" | "failed";

// Interactive username/password form for `codevhub login --admin`. Only local
// ADMIN/SUPERADMIN accounts can use this — regular users are rejected
// server-side and must log in via SSO (`codevhub login`). On success it captures
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
				const msg = describeNetworkError(err);
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
					setError(t("common.field_required", { field: t(current.labelKey) }));
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
				<Text>{` ${t("admin_login.signing_in")}`}</Text>
			</Box>
		);
	}

	const labelWidth = Math.max(...FIELDS.map((f) => t(f.labelKey).length)) + 2;

	return (
		<Box flexDirection="column">
			{FIELDS.map((field, i) => {
				const isActive = phase === "input" && i === index;
				const value = values[field.key];
				const shown = field.mask ? "•".repeat(value.length) : value;
				return (
					<Box key={field.key}>
						{/* <Box width> rather than padEnd: Yoga measures display width,
						    String.padEnd counts UTF-16 code units. */}
						<Box width={labelWidth} flexShrink={0}>
							<Text color={isActive ? "cyan" : undefined} dimColor={!isActive}>
								{`${t(field.labelKey)}: `}
							</Text>
						</Box>
						<Text>{shown}</Text>
						{isActive && <Text color="cyan">▌</Text>}
					</Box>
				);
			})}
			{error && (
				<Box marginTop={1}>
					<Text color="red">{error}</Text>
					{phase === "input" && attempts > 0 && (
						<Text dimColor>
							{`  ${t("admin_login.attempt", { n: attempts, max: maxAttempts })}`}
						</Text>
					)}
					{phase === "failed" && (
						<Text dimColor>
							{`  ${t("admin_login.gave_up", { max: maxAttempts })}`}
						</Text>
					)}
				</Box>
			)}
			{phase === "input" && (
				<Box marginTop={1}>
					<Text dimColor>{t("admin_login.only_admin")}</Text>
				</Box>
			)}
		</Box>
	);
}

export function adminLoginTitle() {
	return <Text bold>{t("admin_login.title")}</Text>;
}
