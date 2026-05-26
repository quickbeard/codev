import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useState } from "react";
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
import type { Credentials, Tool } from "@/lib/configure.js";
import { validateApiKey } from "@/lib/proxy.js";
import { installShims, toolToShimAgent } from "@/lib/shims.js";

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
	| "configuring"
	| "configure-failed"
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
	"configuring",
	"configure-failed",
	"done",
];
const POST_REFRESH: Phase[] = [
	"validating-existing",
	"key-choice",
	"fetching-key",
	"manual-creds",
	"model-choice",
	"configuring",
	"configure-failed",
	"done",
];
const POST_VALIDATE: Phase[] = [
	"key-choice",
	"fetching-key",
	"manual-creds",
	"model-choice",
	"configuring",
	"configure-failed",
	"done",
];
const POST_KEY_CHOICE: Phase[] = [
	"fetching-key",
	"manual-creds",
	"model-choice",
	"configuring",
	"configure-failed",
	"done",
];
const POST_MODEL_CHOICE: Phase[] = ["configuring", "configure-failed", "done"];

export function InstallApp() {
	const { exit } = useApp();
	const [step, setStep] = useState<Phase>("select");
	const [tools, setTools] = useState<Tool[]>([]);
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
	const [chosenModel, setChosenModel] = useState<string | null>(null);

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

	const handleLoginDone = useCallback((authData: AuthData) => {
		setAuth(authData);
		setStep("installing");
	}, []);

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

	// On failure we set a terminal `*-failed` phase and stop advancing. The
	// step's error frame stays rendered so the user can read it; exiting the
	// app is left to the user (Ctrl-C), matching Login/Configure's prior
	// hang-on-error behavior. Soft warnings (Continue extension/plugin
	// install couldn't run cleanly) are rendered as yellow ▲ rows in the
	// install TaskList itself — they don't flip `success` and don't need to
	// propagate further.
	const handleInstallDone = useCallback(
		(success: boolean) => {
			if (!success) {
				setStep("install-failed");
				return;
			}
			// Install PATH shims silently — the final "Done!" message merges the
			// activation hint in. Best-effort: a failure doesn't block install.
			try {
				const shimAgents = tools
					.map(toolToShimAgent)
					.filter((agent) => agent !== null);
				if (shimAgents.length > 0) installShims(shimAgents);
				setShimsInstalled(true);
			} catch {
				// Leave shimsInstalled=false so the resume message stays simple.
			}
			// Refresh runs invisibly between `installing` and the next visible
			// step. The user sees install complete, a brief pause, then the
			// key-choice (or validating-existing) panel — no spinner for the
			// network call itself. Errors are swallowed by refreshCodevConfig,
			// so install always advances.
			setStep("refreshing-config");
			if (!auth) {
				// login() runs before this phase, so this is defensive only.
				advancePastInstall();
				return;
			}
			refreshCodevConfig(auth.access_token, () => {}).finally(() => {
				advancePastInstall();
			});
		},
		[tools, auth, advancePastInstall],
	);

	const handleAuthMethod = useCallback(
		(choice: AuthMethodChoice) => {
			setAuthMethod(choice);
			if (choice === "existing") {
				if (!savedCreds) return;
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
		setCreds({ apiKey: key });
		setStep("model-choice");
	}, []);

	const handleFetchKeyFallback = useCallback(() => {
		setStep("manual-creds");
	}, []);

	const handleManualDone = useCallback((value: ManualCredentialsValue) => {
		// Defer saveApiKey to the model-choice step so we only persist a
		// complete tuple (apiKey + baseUrl + model) to ~/.codev/auth.json.
		setCreds({
			apiKey: value.apiKey,
			baseUrl: value.baseUrl,
		});
		setStep("model-choice");
	}, []);

	const handleModelSelect = useCallback(
		(model: string, models: string[]) => {
			setChosenModel(model);
			setCreds((prev) => (prev ? { ...prev, model, models } : prev));
			// Persist apiKey/baseUrl/model to ~/.codev/auth.json. The full list
			// isn't persisted — it's re-fetched on every install so reinstalls
			// always see the current set.
			if (creds) {
				saveApiKey({ apiKey: creds.apiKey, baseUrl: creds.baseUrl, model });
			}
			setStep("configuring");
		},
		[creds],
	);

	const handleConfigureDone = useCallback(
		(success: boolean) => {
			if (!success) {
				setStep("configure-failed");
				return;
			}
			setStep("done");
			exit();
		},
		[exit],
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Banner />
			<Frame tag="CoDev">
				<Step
					active={step === "select"}
					title={toolSelectTitle(step !== "select")}
				>
					<ToolSelect
						onConfirm={handleToolSelectConfirm}
						readOnly={step !== "select"}
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
				{POST_LOGIN.includes(step) && (
					<Step
						active={step === "installing"}
						title={<Text bold>Installing packages</Text>}
					>
						<Install tools={tools} onDone={handleInstallDone} />
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
								readOnly={step !== "model-choice"}
								selected={chosenModel}
							/>
						</Step>
					)}
				{POST_MODEL_CHOICE.includes(step) &&
					(creds || authMethod === "skip") && (
						<Step
							active={step === "configuring"}
							title={configureTitle(authMethod === "skip")}
						>
							<Configure
								tools={tools}
								creds={creds}
								shimsInstalled={shimsInstalled}
								onDone={handleConfigureDone}
							/>
						</Step>
					)}
			</Frame>
		</Box>
	);
}
