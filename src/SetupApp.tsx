import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useState } from "react";
import type { AuthMethodChoice } from "@/components/AuthMethod.js";
import {
	AuthMethod,
	configurationMethodTitle,
} from "@/components/AuthMethod.js";
import { Banner } from "@/components/Banner.js";
import { Configure, configureTitle } from "@/components/Configure.js";
import { Confirm, confirmTitle } from "@/components/Confirm.js";
import {
	type Editor,
	EditorSelect,
	editorSelectTitle,
} from "@/components/EditorSelect.js";
import { FetchApiKey, fetchApiKeyTitle } from "@/components/FetchApiKey.js";
import { Frame } from "@/components/Frame.js";
import { Install } from "@/components/Install.js";
import { Login, loginTitle } from "@/components/Login.js";
import {
	ManualCredentials,
	type ManualCredentialsValue,
	manualCredentialsTitle,
} from "@/components/ManualCredentials.js";
import { ModelSelect, modelSelectTitle } from "@/components/ModelSelect.js";
import { SetupComplete } from "@/components/SetupComplete.js";
import { Step } from "@/components/Step.js";
import {
	CLAUDE_CODE_EXT_SENTINEL,
	CONTINUE_SENTINEL,
	ToolSelect,
	type ToolSelectValue,
	toolSelectTitle,
} from "@/components/ToolSelect.js";
import {
	type ApiKeyCreds,
	type AuthData,
	loadApiKey,
	refreshCodevConfig,
	saveApiKey,
} from "@/lib/auth.js";
import { smokeTestModel, validateApiKey } from "@/lib/backend.js";
import {
	CODEGRAPH_TASK_KEY,
	type CodegraphSetupResult,
	codegraphTargets,
	formatCodegraphTargets,
	setupCodegraph,
} from "@/lib/codegraph.js";
import {
	backupClaudeAuth,
	type Credentials,
	resetClaudeAuth,
	type Tool,
} from "@/lib/configure.js";
import { FALLBACK_MODEL } from "@/lib/const.js";
import { logApiKeyConfigured, logDebug, logError, logWarn } from "@/lib/log.js";
import { installShims, toolToShimAgent } from "@/lib/shims.js";
import { disableClaudeCodeLoginPrompt } from "@/lib/vscode-settings.js";

type Phase =
	| "select"
	| "editor-select"
	| "confirm"
	| "login"
	| "installing"
	| "install-failed"
	| "refreshing-config"
	| "validating-existing"
	| "key-choice"
	| "fetching-key"
	| "manual-creds"
	| "model-choice"
	| "verifying-gateway"
	| "configuring"
	| "configure-failed"
	| "finalizing"
	| "done";

const POST_LOGIN: Phase[] = [
	"installing",
	"install-failed",
	"refreshing-config",
	"validating-existing",
	"key-choice",
	"fetching-key",
	"manual-creds",
	"model-choice",
	"verifying-gateway",
	"configuring",
	"configure-failed",
	"finalizing",
	"done",
];
const POST_REFRESH: Phase[] = [
	"validating-existing",
	"key-choice",
	"fetching-key",
	"manual-creds",
	"model-choice",
	"verifying-gateway",
	"configuring",
	"configure-failed",
	"finalizing",
	"done",
];
const POST_VALIDATE: Phase[] = [
	"key-choice",
	"fetching-key",
	"manual-creds",
	"model-choice",
	"verifying-gateway",
	"configuring",
	"configure-failed",
	"finalizing",
	"done",
];
const POST_KEY_CHOICE: Phase[] = [
	"fetching-key",
	"manual-creds",
	"model-choice",
	"verifying-gateway",
	"configuring",
	"configure-failed",
	"finalizing",
	"done",
];
const POST_MODEL_CHOICE: Phase[] = [
	"configuring",
	"configure-failed",
	"finalizing",
	"done",
];
// "verifying-gateway and everything after" — gates the smoke-test Step so it
// mounts when the test starts and stays (read-only) through configure/finalize.
const POST_VERIFY_GATEWAY: Phase[] = [
	"verifying-gateway",
	"configuring",
	"configure-failed",
	"finalizing",
	"done",
];

export type SetupMode = "install" | "config";

interface SetupAppProps {
	// "install" runs the full flow including the Install Step (npm install /
	// extension install). "config" skips installation and jumps straight from
	// login → refreshing-config → key-choice → … → configuring, so existing
	// installations can be re-pointed at the self-hosted gateway. Both modes
	// share resetClaudeAuth + installShims side-effects because in either case
	// the goal is for the rewritten settings.json to actually take effect.
	mode: SetupMode;
}

export function SetupApp({ mode }: SetupAppProps) {
	const { exit } = useApp();
	const [step, setStep] = useState<Phase>("select");
	const [tools, setTools] = useState<Tool[]>([]);
	// Survivors of the install step — populated from TaskList's succeededKeys.
	// Drives shim install + the Configure step, so failed tools are quietly
	// dropped from the second half of the flow. We keep `tools` (the
	// original selection) untouched so the readOnly Confirm history still
	// shows what the user picked.
	const [installedTools, setInstalledTools] = useState<Tool[]>([]);
	// Whether the user picked an extension sentinel row in ToolSelect —
	// drives whether EditorSelect is shown (active or readOnly) in later
	// phases. Stored separately from `tools` so the readOnly editor sub-step
	// keeps mounting after the sentinels have been expanded into editor
	// Tools.
	const [claudeCodeExtSelected, setClaudeCodeExtSelected] = useState(false);
	const [continueSelected, setContinueSelected] = useState(false);
	const [auth, setAuth] = useState<AuthData | null>(null);
	const [authMethod, setAuthMethod] = useState<AuthMethodChoice | null>(null);
	const [creds, setCreds] = useState<Credentials | null>(null);
	const [savedCreds, setSavedCreds] = useState<ApiKeyCreds | null>(null);
	const [existingValid, setExistingValid] = useState(false);
	const [existingMessage, setExistingMessage] = useState<string | null>(null);
	const [shimsInstalled, setShimsInstalled] = useState(false);
	// Result of the best-effort CodeGraph setup that runs during the finalize
	// Phase. null while it's still running (drives the spinner); set once
	// setupCodegraph resolves. "skipped" when the selection had no
	// CodeGraph-eligible tools, so the row never renders.
	const [codegraphResult, setCodegraphResult] =
		useState<CodegraphSetupResult | null>(null);
	const [chosenModel, setChosenModel] = useState<string | null>(null);
	// Set when ModelSelect falls back to FALLBACK_MODEL because the gateway's
	// model list couldn't be fetched. Drives a persistent yellow ▲ row above
	// the model step so the user sees why a model was auto-picked.
	const [modelWarning, setModelWarning] = useState<string | null>(null);
	// Set when the post-model smoke test (smokeTestModel) fails — the gateway
	// rejected a real completion for the chosen model (the 403 users otherwise
	// hit at their agent's first message). Drives a prominent ▲ row at the
	// verifying-gateway Step; the flow still proceeds to configure.
	const [smokeWarning, setSmokeWarning] = useState<string | null>(null);
	// Set only when refreshCodevConfig fails. Drives a yellow ▲ row that
	// appears between the install Step and the next visible Step. Stays null
	// (and the row stays unmounted) on the success path, so refresh remains
	// invisible when it works.
	const [refreshWarning, setRefreshWarning] = useState<string | null>(null);

	// Diagnostic trail of the wizard's progress — one document per phase
	// transition, so a stuck or aborted run shows exactly where it stopped.
	useEffect(() => {
		logDebug(`setup step: ${step}`, {
			action: "step.transition",
			extra: { step, mode },
		});
	}, [step, mode]);

	const handleToolSelectConfirm = (selected: ToolSelectValue[]) => {
		const hasClaudeCodeExt = selected.includes(CLAUDE_CODE_EXT_SENTINEL);
		const hasContinue = selected.includes(CONTINUE_SENTINEL);
		setClaudeCodeExtSelected(hasClaudeCodeExt);
		setContinueSelected(hasContinue);
		const baseTools = selected.filter(
			(v): v is Tool =>
				v !== CLAUDE_CODE_EXT_SENTINEL && v !== CONTINUE_SENTINEL,
		);
		if (hasClaudeCodeExt || hasContinue) {
			// Park the non-sentinel picks until the editor sub-select resolves;
			// the sub-step appends editor-specific Tools to this base for each
			// extension the user picked.
			setTools(baseTools);
			setStep("editor-select");
			return;
		}
		setTools(baseTools);
		setStep("confirm");
	};

	const handleEditorsConfirm = (editors: Editor[]) => {
		const newTools: Tool[] = [];
		for (const editor of editors) {
			if (claudeCodeExtSelected) {
				newTools.push(
					editor === "vscode" ? "vscode-claude-code" : "jetbrains-claude-code",
				);
			}
			if (continueSelected) {
				newTools.push(
					editor === "vscode" ? "vscode-continue" : "jetbrains-continue",
				);
			}
		}
		setTools((prev) => [...prev, ...newTools]);
		setStep("confirm");
	};

	const handleConfirmProceed = useCallback(
		(proceed: boolean) => {
			if (!proceed) {
				process.stderr.write("Abort.\n");
				exit(new Error("aborted"));
				return;
			}
			setStep("login");
		},
		[exit],
	);

	const advancePastInstall = useCallback(() => {
		const saved = loadApiKey();
		if (!saved) {
			setStep("key-choice");
			return;
		}
		setSavedCreds(saved);
		setStep("validating-existing");
		validateApiKey(saved.apiKey, saved.baseUrl)
			.then((ok) => {
				if (ok) {
					setExistingValid(true);
				} else {
					setExistingMessage(
						"Saved API key is no longer valid; choose another method.",
					);
				}
			})
			.catch((err: Error) => {
				setExistingMessage(`Could not verify saved API key: ${err.message}`);
			})
			.finally(() => {
				setStep("key-choice");
			});
	}, []);

	// Pins survivors for Configure to read, then kicks off the (invisible)
	// refresh transition. Filesystem-mutating side-effects (resetClaudeAuth,
	// installShims) are deferred to runFinalizeSideEffects after the user
	// has finished every choice — that way a mid-flow Ctrl-C leaves their
	// Claude config files and PATH shims untouched. The authData arg is
	// passed explicitly because `setAuth` and this call may happen in the
	// same React tick (config mode); a state read would still see the
	// prior value.
	const runPostInstallSideEffects = useCallback(
		(survivors: Tool[], authData: AuthData) => {
			setInstalledTools(survivors);
			// Refresh runs invisibly between this point and the next visible
			// step. Errors are swallowed by refreshCodevConfig (and captured
			// into refreshWarning, which surfaces as a yellow ▲ row); the flow
			// always advances.
			setStep("refreshing-config");
			refreshCodevConfig(authData.access_token, (msg) => {
				setRefreshWarning(msg);
			}).finally(() => {
				advancePastInstall();
			});
		},
		[advancePastInstall],
	);

	const handleLoginDone = useCallback(
		(authData: AuthData) => {
			setAuth(authData);
			if (mode === "install") {
				setStep("installing");
				return;
			}
			// Config mode skips the *agent* install (they're treated as already
			// installed, so the survivor set equals `tools`), but still installs
			// CodeGraph. When any selected agent maps to a CodeGraph target, show
			// the CodeGraph-only Install step right after login; otherwise run the
			// post-login side-effects directly. authData is passed explicitly
			// because the setAuth above hasn't flushed to state yet this tick.
			if (codegraphTargets(tools).length > 0) {
				setStep("installing");
			} else {
				runPostInstallSideEffects(tools, authData);
			}
		},
		[mode, tools, runPostInstallSideEffects],
	);

	// Total-failure-only hang: when every selected tool hard-failed (empty
	// succeededKeys) we set the terminal `install-failed` phase and stop
	// advancing. The step's error frame stays rendered so the user can read
	// it; exiting the app is left to the user (Ctrl-C), matching
	// Login/Configure's prior hang-on-error behavior. When at least one
	// tool succeeded (or soft-warned), the flow advances with just the
	// survivors and Configure only writes their configs — the failed rows
	// stay rendered as red ✗ above so the user still sees what dropped out.
	// Soft warnings (Continue extension/plugin install couldn't run cleanly)
	// are rendered as yellow ▲ rows by TaskList and are included in the
	// survivor set.
	const handleInstallDone = useCallback(
		(succeededKeys: string[]) => {
			// login() runs before install, so `auth` is set by the time this
			// fires; the `if (auth)` guards below are defensive — if it were
			// somehow null we'd rather stall than run side-effects without a token.
			//
			// Config mode's Install step only ran the CodeGraph row (agents
			// are assumed already installed), so the survivor set is the full
			// selection regardless of the CodeGraph row's outcome — it's
			// best-effort and must never drop an agent or park the flow.
			if (mode === "config") {
				if (auth) runPostInstallSideEffects(tools, auth);
				return;
			}
			// The CodeGraph task shares this TaskList but isn't an agent: split
			// its sentinel key out so it never flows into the survivor set (Configure
			// / shims would choke on a non-Tool key) and never masks a total agent
			// failure in the fail-stop check below.
			const toolSurvivors = succeededKeys.filter(
				(k): k is Tool => k !== CODEGRAPH_TASK_KEY,
			);
			if (toolSurvivors.length === 0) {
				setStep("install-failed");
				return;
			}
			// Hand straight off to the post-install side-effects. The
			// filesystem-mutating ones (resetClaudeAuth, installShims) still run
			// later in runFinalizeSideEffects; this only kicks off the invisible
			// config refresh + saved-key validation.
			if (auth) runPostInstallSideEffects(toolSurvivors, auth);
		},
		[mode, tools, auth, runPostInstallSideEffects],
	);

	const handleAuthMethod = useCallback(
		(choice: AuthMethodChoice) => {
			setAuthMethod(choice);
			if (choice === "existing") {
				if (!savedCreds) return;
				logApiKeyConfigured(
					"existing",
					savedCreds.apiKey,
					savedCreds.baseUrl,
					savedCreds.model,
				);
				setCreds({
					apiKey: savedCreds.apiKey,
					baseUrl: savedCreds.baseUrl,
					model: savedCreds.model,
				});
				// Don't pre-mark the saved model as selected — the green ● should
				// only appear after the user actually picks a row on this run.
				// chosenModel stays null until handleModelSelect runs.
				setStep("model-choice");
				return;
			}
			if (choice === "skip") {
				setCreds(null);
				setStep("configuring");
				return;
			}
			setStep(choice === "new" ? "fetching-key" : "manual-creds");
		},
		[savedCreds],
	);

	const handleFetchKeyDone = useCallback((key: string) => {
		// Persist the apiKey immediately so a Ctrl-C between here and
		// model-choice preserves partial progress. base_url/model are still
		// undefined on this branch (SSO-fetched key uses the default gateway);
		// the model step will re-save with the full tuple.
		saveApiKey({ apiKey: key });
		logApiKeyConfigured("new", key);
		setCreds({ apiKey: key });
		setStep("model-choice");
	}, []);

	const handleFetchKeyFallback = useCallback(() => {
		setStep("manual-creds");
	}, []);

	const handleManualDone = useCallback((value: ManualCredentialsValue) => {
		logApiKeyConfigured("manual", value.apiKey, value.baseUrl);
		// Defer saveApiKey to the model-choice step so we only persist a
		// complete tuple (apiKey + baseUrl + model) to ~/.codev/auth.json.
		setCreds({
			apiKey: value.apiKey,
			baseUrl: value.baseUrl,
		});
		setStep("model-choice");
	}, []);

	const handleModelFallback = useCallback((err: Error) => {
		// Record WHY the fallback was taken (the underlying fetch error) as one
		// clear event, so `codevhub logs` shows the cause without correlating the
		// raw gateway.models http.request doc.
		logWarn("model list fetch failed; using fallback model", {
			action: "model.fallback",
			err,
			extra: { fallback_model: FALLBACK_MODEL },
		});
		setModelWarning(
			`Couldn't fetch the model list (${err.message}); using fallback model ${FALLBACK_MODEL}.`,
		);
	}, []);

	const handleModelSelect = useCallback(
		(model: string, models: string[]) => {
			setChosenModel(model);
			setCreds((prev) => (prev ? { ...prev, model, models } : prev));
			// Persist apiKey/baseUrl/model to ~/.codev/auth.json. The full list
			// isn't persisted — it's re-fetched on every install so reinstalls
			// always see the current set.
			if (!creds) {
				// Defensive: the model step doesn't render on the skip path, so
				// there's normally no creds-less selection. Nothing to test/persist.
				setStep("configuring");
				return;
			}
			saveApiKey({ apiKey: creds.apiKey, baseUrl: creds.baseUrl, model });
			// Smoke-test the chosen model before writing configs: a 1-token
			// completion through the gateway surfaces a runtime 403 (key not
			// allowed for the model / over budget / edge block) HERE instead of at
			// the agent's first message. Best-effort — a failure warns but the
			// flow still proceeds to configure.
			setStep("verifying-gateway");
			smokeTestModel(creds.apiKey, model, creds.baseUrl)
				.then((reason) => {
					if (!reason) return;
					setSmokeWarning(reason);
					logWarn("gateway smoke test failed", {
						action: "configure.smoke-test",
						outcome: "failure",
						extra: { model, reason },
					});
				})
				.catch(() => {
					// smokeTestModel swallows its own errors; defensive only.
				})
				.finally(() => setStep("configuring"));
		},
		[creds],
	);

	// Filesystem-mutating finalize work. Runs once Configure succeeds, when
	// the user has clicked through every choice — so a mid-flow Ctrl-C leaves
	// disk untouched. Skip-configuration is signaled by `creds === null`,
	// which routes Claude through backupClaudeAuth() (snapshot only) instead
	// of resetClaudeAuth() (snapshot + replace .claude.json + remove
	// .credentials.json). Both halves are best-effort; we always advance to
	// the terminal "done" Phase.
	const runFinalizeSideEffects = useCallback(
		(currentCreds: Credentials | null) => {
			const hasClaudeTool = installedTools.some(
				(t) =>
					t === "claude-code" ||
					t === "vscode-claude-code" ||
					t === "jetbrains-claude-code",
			);
			if (hasClaudeTool) {
				try {
					if (currentCreds === null) {
						backupClaudeAuth();
					} else {
						resetClaudeAuth();
						// codev now owns Claude's gateway auth via settings.json, so
						// suppress the Claude Code VS Code extension's redundant login
						// prompt. Gated internally on VS Code being installed. The
						// Skip-configuration path (creds === null) deliberately leaves
						// it alone — the extension still needs its normal login there.
						disableClaudeCodeLoginPrompt();
					}
				} catch (err) {
					// Swallow — the flow always advances.
					logError("claude auth backup/reset failed during finalize", { err });
				}
			}
			try {
				const shimAgents = installedTools
					.map(toolToShimAgent)
					.filter((agent) => agent !== null);
				if (shimAgents.length > 0) installShims(shimAgents);
				setShimsInstalled(true);
			} catch (err) {
				// Leave shimsInstalled=false so the terminal message degrades to
				// plain "Done!".
				logError("shim install failed during finalize", { err });
			}
			// Best-effort CodeGraph wiring. The CLI install already ran in the
			// Install step (both install and config mode), so this only runs
			// `codegraph install` to wire the MCP server into each selected agent.
			// The flow holds on "finalizing" (spinner) until this resolves; a
			// failure surfaces as a warning row but never blocks completion.
			// setupCodegraph never throws, but the catch is defensive.
			setupCodegraph(installedTools)
				.then(setCodegraphResult)
				.catch((err: unknown) =>
					setCodegraphResult({
						status: "warning",
						targets: codegraphTargets(installedTools),
						message: `CodeGraph setup could not run: ${
							err instanceof Error ? err.message : String(err)
						}`,
					}),
				)
				.finally(() => {
					setStep("done");
					// Hold the terminal frame for ~1s so the user can read "Done! Run
					// exec $SHELL" and "Happy coding!" before Ink tears down. Without
					// this, React's render of the "done" Phase wouldn't flush to the
					// terminal before exit() unmounts the app.
					setTimeout(() => exit(), 1000);
				});
		},
		[installedTools, exit],
	);

	const handleConfigureDone = useCallback(
		(success: boolean) => {
			if (!success) {
				setStep("configure-failed");
				return;
			}
			setStep("finalizing");
			runFinalizeSideEffects(creds);
		},
		[creds, runFinalizeSideEffects],
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step
					active={step === "select"}
					title={toolSelectTitle(step !== "select", mode)}
				>
					<ToolSelect
						onConfirm={handleToolSelectConfirm}
						readOnly={step !== "select"}
						mode={mode}
					/>
				</Step>
				{(claudeCodeExtSelected || continueSelected) && step !== "select" && (
					<Step
						active={step === "editor-select"}
						title={editorSelectTitle(step !== "editor-select")}
					>
						<EditorSelect
							onConfirm={handleEditorsConfirm}
							readOnly={step !== "editor-select"}
						/>
					</Step>
				)}
				{step !== "select" && step !== "editor-select" && (
					<Step active={step === "confirm"} title={confirmTitle()}>
						<Confirm
							tools={tools}
							onConfirm={handleConfirmProceed}
							readOnly={step !== "confirm"}
						/>
					</Step>
				)}
				{step !== "select" &&
					step !== "editor-select" &&
					step !== "confirm" && (
						<Step active={step === "login"} title={loginTitle()}>
							<Login onDone={handleLoginDone} />
						</Step>
					)}
				{(mode === "install" ||
					(mode === "config" && codegraphTargets(tools).length > 0)) &&
					POST_LOGIN.includes(step) && (
						<Step
							active={step === "installing"}
							title={
								<Text bold>
									{mode === "install"
										? "Installing packages"
										: "Installing CodeGraph"}
								</Text>
							}
						>
							<Install
								tools={tools}
								includeAgents={mode === "install"}
								onDone={handleInstallDone}
							/>
						</Step>
					)}
				{POST_REFRESH.includes(step) && refreshWarning && (
					<Step title={<Text bold>Refresh CoDev config</Text>}>
						<Box>
							<Text color="yellow">▲</Text>
							<Text color="yellow">{` ${refreshWarning}`}</Text>
						</Box>
					</Step>
				)}
				{POST_REFRESH.includes(step) && savedCreds && (
					<Step
						active={step === "validating-existing"}
						title={<Text bold>Checking saved API key</Text>}
					>
						{step === "validating-existing" ? (
							<Box>
								<Text color="cyan">
									<Spinner />
								</Text>
								<Text> Verifying with gateway...</Text>
							</Box>
						) : (
							<Text dimColor>
								{existingValid
									? "Saved API key is valid."
									: (existingMessage ?? "")}
							</Text>
						)}
					</Step>
				)}
				{POST_VALIDATE.includes(step) && (
					<Step
						active={step === "key-choice"}
						title={configurationMethodTitle(step !== "key-choice")}
					>
						<AuthMethod
							onSelect={handleAuthMethod}
							readOnly={step !== "key-choice"}
							selected={authMethod}
							hasExisting={existingValid}
						/>
					</Step>
				)}
				{POST_KEY_CHOICE.includes(step) && authMethod === "new" && auth && (
					<Step active={step === "fetching-key"} title={fetchApiKeyTitle()}>
						<FetchApiKey
							auth={auth}
							onDone={handleFetchKeyDone}
							onFallback={handleFetchKeyFallback}
						/>
					</Step>
				)}
				{POST_KEY_CHOICE.includes(step) &&
					(authMethod === "manual" ||
						(authMethod === "new" && step === "manual-creds")) && (
						<Step
							active={step === "manual-creds"}
							title={manualCredentialsTitle()}
						>
							<ManualCredentials
								onDone={handleManualDone}
								readOnly={step !== "manual-creds"}
							/>
						</Step>
					)}
				{POST_KEY_CHOICE.includes(step) &&
					authMethod !== "skip" &&
					modelWarning && (
						<Step title={<Text bold>Model list</Text>}>
							<Box>
								<Text color="yellow">▲</Text>
								<Text color="yellow">{` ${modelWarning}`}</Text>
							</Box>
						</Step>
					)}
				{POST_KEY_CHOICE.includes(step) &&
					authMethod !== "skip" &&
					creds &&
					step !== "fetching-key" &&
					step !== "manual-creds" && (
						<Step
							active={step === "model-choice"}
							title={modelSelectTitle(step !== "model-choice")}
						>
							<ModelSelect
								apiKey={creds.apiKey}
								baseUrl={creds.baseUrl}
								onSelect={handleModelSelect}
								onFallback={handleModelFallback}
								fallbackModel={FALLBACK_MODEL}
								readOnly={step !== "model-choice"}
								selected={chosenModel}
							/>
						</Step>
					)}
				{POST_VERIFY_GATEWAY.includes(step) && creds && (
					<Step
						active={step === "verifying-gateway"}
						title={<Text bold>Verifying gateway access</Text>}
					>
						{step === "verifying-gateway" ? (
							<Box>
								<Text color="cyan">
									<Spinner />
								</Text>
								<Text>{` Sending a test request to ${chosenModel ?? "the model"}…`}</Text>
							</Box>
						) : smokeWarning ? (
							<Box flexDirection="column">
								<Box>
									<Text color="yellow">▲</Text>
									<Text color="yellow">{` ${smokeWarning}`}</Text>
								</Box>
								<Text dimColor>
									{
										"Config was still written, but your agents will hit this same error — fix gateway access (model entitlement, budget, or region/IP), then relaunch."
									}
								</Text>
							</Box>
						) : (
							<Text dimColor>{"Gateway accepted a test request."}</Text>
						)}
					</Step>
				)}
				{POST_MODEL_CHOICE.includes(step) &&
					(creds || authMethod === "skip") &&
					(authMethod === "skip" ? (
						// Skip configuration runs Configure for its backup
						// side-effects only — rendered bare (no Step, no title) so
						// nothing appears in the TUI. Configure itself emits no rows
						// on the creds === null path.
						<Configure
							tools={installedTools}
							creds={creds}
							onDone={handleConfigureDone}
						/>
					) : (
						<Step active={step === "configuring"} title={configureTitle()}>
							<Configure
								tools={installedTools}
								creds={creds}
								onDone={handleConfigureDone}
							/>
						</Step>
					))}
				{(step === "finalizing" || step === "done") &&
					codegraphTargets(installedTools).length > 0 &&
					codegraphResult?.status !== "skipped" && (
						<Step
							active={step === "finalizing"}
							title={<Text bold>Set up CodeGraph</Text>}
						>
							{codegraphResult === null ? (
								<Box>
									<Text color="cyan">
										<Spinner />
									</Text>
									<Text> Setting up CodeGraph…</Text>
								</Box>
							) : codegraphResult.status === "warning" ? (
								<Box>
									<Text color="yellow">▲</Text>
									<Text color="yellow">
										{` ${codegraphResult.message ?? "CodeGraph setup did not complete."}`}
									</Text>
								</Box>
							) : (
								<Text dimColor>
									{`Wired CodeGraph into ${formatCodegraphTargets(codegraphResult.targets)}.`}
								</Text>
							)}
						</Step>
					)}
				{step === "done" && (
					<SetupComplete
						tools={installedTools}
						shimsInstalled={shimsInstalled}
					/>
				)}
			</Frame>
		</Box>
	);
}
