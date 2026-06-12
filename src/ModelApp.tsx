import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@/components/Banner.js";
import { FetchApiKey, fetchApiKeyTitle } from "@/components/FetchApiKey.js";
import { Frame } from "@/components/Frame.js";
import { Login, loginTitle } from "@/components/Login.js";
import {
	ManualCredentials,
	type ManualCredentialsValue,
	manualCredentialsTitle,
} from "@/components/ManualCredentials.js";
import { ModelSelect, modelSelectTitle } from "@/components/ModelSelect.js";
import { Step } from "@/components/Step.js";
import { type AuthData, loadApiKey, saveApiKey } from "@/lib/auth.js";
import { isInvalidKeyError } from "@/lib/backend.js";
import {
	type Credentials,
	configureClaudeCode,
	configureCodex,
	configureContinue,
	configureOpenCode,
	detectConfiguredTools,
	type Tool,
} from "@/lib/configure.js";
import { FALLBACK_MODEL } from "@/lib/const.js";
import { logError, logInfo, logWarn } from "@/lib/log.js";
import { formatToolList } from "@/lib/text.js";

// ModelSelect handles its own /v1/models fetch — we don't duplicate it here.
// The "model-choice" phase mounts ModelSelect (which shows its own spinner
// during loading), the re-auth phases mount Login/FetchApiKey/ManualCredentials,
// and "configuring" runs the per-tool configure calls.
type Phase =
	| "loading"
	| "no-creds"
	| "no-tools"
	| "re-auth-login"
	| "re-auth-fetch-key"
	| "re-auth-manual"
	| "model-choice"
	| "configuring"
	| "done"
	| "failed";

// `detectConfiguredTools` only ever returns the canonical Tool for each
// shared BackupKind (`claude-code` for the Claude Code config; `vscode-
// continue` for the Continue config), but the Tool union forces an entry
// for every variant — label them with the same editor-neutral string for
// safety.
const TOOL_LABEL: Record<Tool, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	"vscode-claude-code": "Claude Code",
	"jetbrains-claude-code": "Claude Code",
	"vscode-continue": "Continue",
	"jetbrains-continue": "Continue",
};

export function ModelApp() {
	const { exit } = useApp();
	const [phase, setPhase] = useState<Phase>("loading");
	const [creds, setCreds] = useState<Credentials | null>(null);
	const [tools, setTools] = useState<Tool[]>([]);
	const [chosenModel, setChosenModel] = useState<string | null>(null);
	// Set when ModelSelect falls back to FALLBACK_MODEL because the gateway's
	// model list couldn't be fetched. Rendered as a persistent yellow ▲ row.
	const [modelWarning, setModelWarning] = useState<string | null>(null);
	const [auth, setAuth] = useState<AuthData | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Re-auth happens at most once per session. If the new key is *also*
	// invalid, give up and tell the user to re-run codev install.
	const reAuthed = useRef(false);
	const configured = useRef(false);

	// Initial load: read saved creds + detect tools. On success, jump straight
	// to model-choice — ModelSelect does its own fetch.
	useEffect(() => {
		if (phase !== "loading") return;
		const saved = loadApiKey();
		if (!saved) {
			setPhase("no-creds");
			return;
		}
		const detected = detectConfiguredTools();
		if (detected.length === 0) {
			setPhase("no-tools");
			return;
		}
		setCreds({
			apiKey: saved.apiKey,
			baseUrl: saved.baseUrl,
			model: saved.model,
		});
		setTools(detected);
		setPhase("model-choice");
	}, [phase]);

	// ModelSelect's onError handler. On invalid key, branch to re-auth (SSO
	// vs manual) based on whether the saved key had a baseUrl. Any other
	// error (network/5xx/timeout/empty list) is left to ModelSelect's
	// in-component retry prompt — we stay on this step so the user can press
	// Enter to retry without re-running `codev model`.
	const handleModelsError = useCallback(
		(err: Error) => {
			if (!isInvalidKeyError(err)) return;
			logWarn("saved API key rejected by gateway; re-authenticating", { err });
			if (reAuthed.current) {
				setError(
					`${err.message}\nRe-authentication did not produce a valid key. Run 'codev install' to refresh credentials.`,
				);
				setPhase("failed");
				return;
			}
			setPhase(creds?.baseUrl ? "re-auth-manual" : "re-auth-login");
		},
		[creds],
	);

	// Exit when we hit a terminal phase. Defer with setTimeout so Ink flushes
	// the final frame (the success / error message) before unmount.
	useEffect(() => {
		if (phase === "done") {
			const id = setTimeout(() => exit(), 800);
			return () => clearTimeout(id);
		}
		if (phase === "failed") {
			exit(new Error(error ?? "model command failed"));
			return;
		}
		if (phase === "no-creds" || phase === "no-tools") {
			exit(new Error(phase));
		}
	}, [phase, error, exit]);

	const handleLoginDone = useCallback((authData: AuthData) => {
		setAuth(authData);
		setPhase("re-auth-fetch-key");
	}, []);

	const handleFetchKeyDone = useCallback(
		(apiKey: string) => {
			// Persist the new key alongside the previous baseUrl/model so a
			// Ctrl-C between here and `configuring` leaves auth.json coherent.
			saveApiKey({
				apiKey,
				baseUrl: creds?.baseUrl,
				model: creds?.model,
			});
			setCreds((prev) =>
				prev ? { ...prev, apiKey } : { apiKey, model: undefined },
			);
			reAuthed.current = true;
			setPhase("model-choice");
		},
		[creds],
	);

	const handleFetchKeyFallback = useCallback(() => {
		setPhase("re-auth-manual");
	}, []);

	const handleManualDone = useCallback(
		(value: ManualCredentialsValue) => {
			saveApiKey({
				apiKey: value.apiKey,
				baseUrl: value.baseUrl,
				model: creds?.model,
			});
			setCreds((prev) =>
				prev
					? { ...prev, apiKey: value.apiKey, baseUrl: value.baseUrl }
					: { apiKey: value.apiKey, baseUrl: value.baseUrl, model: undefined },
			);
			reAuthed.current = true;
			setPhase("model-choice");
		},
		[creds],
	);

	const handleModelFallback = useCallback((err: Error) => {
		setModelWarning(
			`Couldn't fetch the model list (${err.message}); using fallback model ${FALLBACK_MODEL}.`,
		);
	}, []);

	const handleModelSelect = useCallback((model: string, models: string[]) => {
		setChosenModel(model);
		setCreds((prev) => (prev ? { ...prev, model, models } : prev));
		setPhase("configuring");
	}, []);

	// Run the per-tool configure calls when entering `configuring`.
	useEffect(() => {
		if (phase !== "configuring" || !creds || configured.current) return;
		configured.current = true;
		try {
			for (const tool of tools) {
				if (
					tool === "claude-code" ||
					tool === "vscode-claude-code" ||
					tool === "jetbrains-claude-code"
				)
					configureClaudeCode(creds);
				else if (tool === "codex") configureCodex(creds);
				else if (tool === "opencode") configureOpenCode(creds);
				else if (tool === "vscode-continue" || tool === "jetbrains-continue")
					configureContinue(creds);
			}
			saveApiKey({
				apiKey: creds.apiKey,
				baseUrl: creds.baseUrl,
				model: creds.model,
			});
			logInfo(`default model updated to ${creds.model}`, {
				action: "configure.tool",
				outcome: "success",
				extra: { model: creds.model, tools },
			});
			setPhase("done");
		} catch (err) {
			logError("model configure failed", {
				action: "configure.tool",
				outcome: "failure",
				err,
				extra: { tools },
			});
			setError((err as Error).message);
			setPhase("failed");
		}
	}, [phase, creds, tools]);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				{phase === "loading" && (
					<Box>
						<Text color="cyan">
							<Spinner />
						</Text>
						<Text> Loading saved credentials...</Text>
					</Box>
				)}

				{phase === "no-creds" && (
					<Text color="red">
						{"No CoDev credentials found. Run "}
						<Text color="cyan">codev install</Text>
						{" first."}
					</Text>
				)}

				{phase === "no-tools" && (
					<Text color="red">
						{"No CoDev-configured AI tools found. Run "}
						<Text color="cyan">codev install</Text>
						{" first."}
					</Text>
				)}

				{(phase === "re-auth-login" ||
					phase === "re-auth-fetch-key" ||
					phase === "re-auth-manual") && (
					<Box marginBottom={1}>
						<Text color="yellow">
							{
								"Saved API key was rejected — refreshing credentials before continuing."
							}
						</Text>
					</Box>
				)}

				{phase === "re-auth-login" && (
					<Step active title={loginTitle()}>
						<Login onDone={handleLoginDone} />
					</Step>
				)}

				{phase === "re-auth-fetch-key" && auth && (
					<Step active title={fetchApiKeyTitle()}>
						<FetchApiKey
							auth={auth}
							onDone={handleFetchKeyDone}
							onFallback={handleFetchKeyFallback}
						/>
					</Step>
				)}

				{phase === "re-auth-manual" && (
					<Step active title={manualCredentialsTitle()}>
						<ManualCredentials onDone={handleManualDone} />
					</Step>
				)}

				{phase === "model-choice" && creds && (
					<Step active title={modelSelectTitle()}>
						<ModelSelect
							apiKey={creds.apiKey}
							baseUrl={creds.baseUrl}
							onSelect={handleModelSelect}
							onError={handleModelsError}
							onFallback={handleModelFallback}
							fallbackModel={FALLBACK_MODEL}
							selected={chosenModel}
						/>
					</Step>
				)}

				{modelWarning &&
					(phase === "model-choice" ||
						phase === "configuring" ||
						phase === "done") && (
						<Box marginBottom={1}>
							<Text color="yellow">▲</Text>
							<Text color="yellow">{` ${modelWarning}`}</Text>
						</Box>
					)}

				{(phase === "configuring" || phase === "done") && (
					<Step
						active={phase === "configuring"}
						title={<Text bold>Update tool configs</Text>}
					>
						{phase === "configuring" && (
							<Box>
								<Text color="cyan">
									<Spinner />
								</Text>
								<Text> Updating tool configs...</Text>
							</Box>
						)}
						{phase === "done" && chosenModel && (
							<Text>
								{"Default model updated to "}
								<Text color="cyan">{chosenModel}</Text>
								{" for "}
								{formatToolList(tools.map((t) => TOOL_LABEL[t]))}
								{"."}
							</Text>
						)}
					</Step>
				)}

				{phase === "failed" && error && <Text color="red">{error}</Text>}
			</Frame>
		</Box>
	);
}
