import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLogin, adminLoginTitle } from "@/components/AdminLogin.js";
import { Banner } from "@/components/Banner.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import { Step } from "@/components/Step.js";
import { type AuthData, logout, refreshCodevConfig } from "@/lib/auth.js";
import type { SkillhubUser } from "@/lib/skillhub.js";

type Phase = "preparing" | "login" | "refreshing-config" | "done";

interface LoginAppProps {
	force?: boolean;
	// `codev login --admin`: local username/password sign-in for
	// ADMIN/SUPERADMIN accounts, instead of the default Viettel SSO flow.
	admin?: boolean;
}

export function LoginApp({ force = false, admin = false }: LoginAppProps) {
	if (admin) return <AdminLoginApp />;
	return <SsoLoginApp force={force} />;
}

// Admin (username/password) sign-in flow. Separate from the SSO app
// because it shares none of its state — no browser, no token refresh, no
// codev-config fetch; it just captures and stores the session cookie.
function AdminLoginApp() {
	const { exit } = useApp();
	const [user, setUser] = useState<SkillhubUser | null>(null);

	const handleDone = useCallback(
		(u: SkillhubUser) => {
			setUser(u);
			// Hold the success frame briefly before returning terminal control.
			setTimeout(() => exit(), 500);
		},
		[exit],
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step active title={adminLoginTitle()}>
					{user ? (
						<Text color="green">{`✓ Logged in as ${user.username} (${user.role})`}</Text>
					) : (
						<AdminLogin onDone={handleDone} />
					)}
				</Step>
			</Frame>
		</Box>
	);
}

function SsoLoginApp({ force = false }: { force?: boolean }) {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>(force ? "preparing" : "login");
	const [auth, setAuth] = useState<AuthData | null>(null);
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
			setAuth(authData);
			setPhase("refreshing-config");
			refreshCodevConfig(authData.access_token, () => {}).finally(() => {
				setPhase("done");
				// Hold the final frame on screen briefly so the success line is
				// readable before terminal control returns. Matches UpdateApp.
				setTimeout(() => exit(), 500);
			});
		},
		[exit],
	);

	return (
		<Box flexDirection="column" padding={1}>
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
				{auth && phase === "done" && (
					<Box marginTop={1}>
						<Text color="green">{`✓ Logged in as ${auth.user.email}`}</Text>
					</Box>
				)}
			</Frame>
		</Box>
	);
}
