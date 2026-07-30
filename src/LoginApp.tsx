import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { AdminLogin, adminLoginTitle } from "@/components/AdminLogin.js";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import {
	type AuthData,
	logout,
	refreshCodevConfig,
	saveSkillhubCookie,
} from "@/lib/auth.js";
import { type SkillhubUser, skillhubSignIn } from "@/lib/skillhub.js";
import { describeNetworkError } from "@/lib/tls.js";

type Phase = "preparing" | "login" | "refreshing-config" | "done";

interface LoginAppProps {
	force?: boolean;
	// `codevhub login --admin`: local username/password sign-in for
	// ADMIN/SUPERADMIN accounts, instead of the default Viettel SSO flow.
	admin?: boolean;
	// Non-interactive admin credentials from `codevhub login --username/--password`.
	// When both are present AdminLoginApp signs in without rendering the form.
	username?: string;
	password?: string;
}

export function LoginApp({
	force = false,
	admin = false,
	username,
	password,
}: LoginAppProps) {
	if (admin) return <AdminLoginApp username={username} password={password} />;
	return <SsoLoginApp force={force} />;
}

// Admin (username/password) sign-in flow. Separate from the SSO app
// because it shares none of its state — no browser, no token refresh, no
// codev-config fetch; it just captures and stores the session cookie.
//
// Interactive by default (renders <AdminLogin>). When both `username` and
// `password` are supplied on the CLI it signs in headlessly instead — sign-in
// failure rejects waitUntilExit (via exit(err)) so the command exits non-zero.
function AdminLoginApp({
	username,
	password,
}: {
	username?: string;
	password?: string;
}) {
	const { exit } = useApp();
	const [user, setUser] = useState<SkillhubUser | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Both credentials present → skip the form and sign in directly.
	const nonInteractive = username !== undefined && password !== undefined;
	const didRunRef = useRef(false);

	const handleDone = useCallback(
		(u: SkillhubUser) => {
			setUser(u);
			// Hold the success frame briefly before returning terminal control.
			setTimeout(() => exit(), 500);
		},
		[exit],
	);

	// The interactive form gave up after its attempt cap. <AdminLogin> keeps its
	// own "giving up" frame on screen, so just hold briefly for readability, then
	// reject waitUntilExit so the dispatcher exits non-zero.
	const handleFail = useCallback(
		(msg: string) => {
			setTimeout(() => exit(new Error(msg)), 800);
		},
		[exit],
	);

	useEffect(() => {
		if (!nonInteractive || didRunRef.current) return;
		didRunRef.current = true;
		void (async () => {
			try {
				// Trim the username (paste/env can carry stray whitespace); never
				// touch the password — leading/trailing spaces can be significant.
				const { cookie, user: u } = await skillhubSignIn(
					(username ?? "").trim(),
					password ?? "",
				);
				saveSkillhubCookie(cookie);
				handleDone(u);
			} catch (err) {
				const msg = describeNetworkError(err);
				setError(msg);
				// Reject waitUntilExit so the dispatcher exits non-zero; hold the
				// error frame briefly so it's readable first.
				setTimeout(() => exit(new Error(msg)), 500);
			}
		})();
	}, [nonInteractive, username, password, handleDone, exit]);

	let content: ReactNode;
	if (user) {
		content = (
			<Text color="green">{`✓ Logged in as ${user.username} (${user.role})`}</Text>
		);
	} else if (error) {
		content = <Text color="red">{`Login failed: ${error}`}</Text>;
	} else if (nonInteractive) {
		content = (
			<Box>
				<Text color="cyan">
					<Spinner />
				</Text>
				<Text>{" Signing in..."}</Text>
			</Box>
		);
	} else {
		content = <AdminLogin onDone={handleDone} onFail={handleFail} />;
	}

	return (
		<Box flexDirection="column" paddingX={1} paddingBottom={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step active title={adminLoginTitle()}>
					{content}
				</Step>
			</Frame>
		</Box>
	);
}

function SsoLoginApp({ force = false }: { force?: boolean }) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>(force ? "preparing" : "login");
	const didPrepRef = useRef(false);

	// --force wipes the cached SSO session (and arms the force-login sentinel,
	// so the IdP shows its credential form instead of silently re-using a
	// browser cookie) before <Login> mounts and reads the still-valid cache.
	useEffect(() => {
		if (!force || didPrepRef.current) return;
		didPrepRef.current = true;
		logout().finally(() => setPhase("login"));
	}, [force]);

	const handleLoginDone = useCallback(
		(authData: AuthData) => {
			setPhase("refreshing-config");
			refreshCodevConfig(authData.access_token, () => {}).finally(() => {
				setPhase("done");
				// Hold the final frame on screen briefly so <Login>'s green
				// "Signed in as …" line is readable before terminal control returns.
				setTimeout(() => exit(), 500);
			});
		},
		[exit],
	);

	return (
		<Box flexDirection="column" paddingX={1} paddingBottom={1}>
			<Banner />
			<Frame tag="CoDev">
				{phase === "preparing" && (
					<Step active title={<Text bold>Signing out previous session</Text>}>
						<Text dimColor>Revoking tokens...</Text>
					</Step>
				)}
				{phase !== "preparing" && (
					<Step active={phase === "login"} title={loginTitle()}>
						<Login onDone={handleLoginDone} />
					</Step>
				)}
			</Frame>
		</Box>
	);
}
