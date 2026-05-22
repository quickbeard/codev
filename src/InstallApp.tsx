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
import {
	ProxyUrl,
	type ProxyUrlChoice,
	proxyUrlTitle,
} from "@/components/ProxyUrl.js";
import { Step } from "@/components/Step.js";
import { ToolSelect, toolSelectTitle } from "@/components/ToolSelect.js";
import {
	type ApiKeyCreds,
	type AuthData,
	loadApiKey,
	refreshCodevConfig,
	saveApiKey,
	saveProxyUrl,
} from "@/lib/auth.js";
import { type Credentials, DEFAULT_MODEL, type Tool } from "@/lib/configure.js";
import { validateApiKey } from "@/lib/proxy.js";
import { installShims, toolToShimAgent } from "@/lib/shims.js";

type Phase =
	| "select"
	| "confirm"
	| "login"
	| "installing"
	| "install-failed"
	| "proxy-url-choice"
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
	"proxy-url-choice",
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
const POST_INSTALL: Phase[] = [
	"proxy-url-choice",
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
const POST_PROXY_CHOICE: Phase[] = [
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
	const [auth, setAuth] = useState<AuthData | null>(null);
	const [authMethod, setAuthMethod] = useState<AuthMethodChoice | null>(null);
	const [creds, setCreds] = useState<Credentials | null>(null);
	const [savedCreds, setSavedCreds] = useState<ApiKeyCreds | null>(null);
	const [existingValid, setExistingValid] = useState(false);
	const [existingMessage, setExistingMessage] = useState<string | null>(null);
	const [shimsInstalled, setShimsInstalled] = useState(false);
	const [proxyChoice, setProxyChoice] = useState<ProxyUrlChoice | null>(null);
	const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
	const [chosenModel, setChosenModel] = useState<string | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);

	const handleConfirm = (selected: Tool[]) => {
		setTools(selected);
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
	// hang-on-error behavior.
	const handleInstallDone = useCallback(
		(success: boolean) => {
			if (!success) {
				setStep("install-failed");
				return;
			}
			// Install PATH shims silently — the final "Done!" message merges the
			// activation hint in. Best-effort: a failure doesn't block install.
			try {
				installShims(tools.map(toolToShimAgent));
				setShimsInstalled(true);
			} catch {
				// Leave shimsInstalled=false so the resume message stays simple.
			}
			setStep("proxy-url-choice");
		},
		[tools],
	);

	const handleProxyUrlDone = useCallback(
		(url: string | null) => {
			saveProxyUrl(url);
			setProxyChoice(url === null ? "default" : "custom");
			setStep("refreshing-config");
			if (!auth) {
				// login() runs before this phase, so this is defensive only.
				advancePastInstall();
				return;
			}
			refreshCodevConfig(auth.access_token, (msg) => {
				setRefreshMessage(msg);
			}).finally(() => {
				advancePastInstall();
			});
		},
		[auth, advancePastInstall],
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

	// Models fetch failed (network error, timeout, auth error, or empty list).
	// Fall back to DEFAULT_MODEL and continue — install must not block on a
	// transient gateway issue. `models` becomes a one-entry list so OpenCode's
	// models map ends up with exactly one valid entry. The yellow warning in
	// the model-choice step tells the user what happened.
	const handleModelsFailed = useCallback(
		(err: Error) => {
			setModelsError(err.message);
			setChosenModel(DEFAULT_MODEL);
			setCreds((prev) =>
				prev
					? { ...prev, model: DEFAULT_MODEL, models: [DEFAULT_MODEL] }
					: prev,
			);
			if (creds) {
				saveApiKey({
					apiKey: creds.apiKey,
					baseUrl: creds.baseUrl,
					model: DEFAULT_MODEL,
				});
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
					<ToolSelect onConfirm={handleConfirm} readOnly={step !== "select"} />
				</Step>
				{step !== "select" && (
					<Step active={step === "confirm"} title={confirmTitle()}>
						<Confirm
							tools={tools}
							onConfirm={handleConfirmProceed}
							readOnly={step !== "confirm"}
						/>
					</Step>
				)}
				{step !== "select" && step !== "confirm" && (
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
				{POST_INSTALL.includes(step) && (
					<Step
						active={step === "proxy-url-choice"}
						title={proxyUrlTitle(step !== "proxy-url-choice")}
					>
						<ProxyUrl
							onDone={handleProxyUrlDone}
							readOnly={step !== "proxy-url-choice"}
							selected={proxyChoice}
						/>
					</Step>
				)}
				{POST_PROXY_CHOICE.includes(step) && (
					<Step
						active={step === "refreshing-config"}
						title={<Text bold>Refreshing CoDev config</Text>}
					>
						{step === "refreshing-config" ? (
							<Box>
								<Text color="cyan">
									<Spinner />
								</Text>
								<Text> Fetching Supabase coordinates from proxy...</Text>
							</Box>
						) : (
							<Text dimColor>{refreshMessage ?? "Refreshed."}</Text>
						)}
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
							{modelsError ? (
								<Text color="yellow">{`Failed to fetch models (${modelsError}). Using default model.`}</Text>
							) : (
								<ModelSelect
									apiKey={creds.apiKey}
									baseUrl={creds.baseUrl}
									onSelect={handleModelSelect}
									onError={handleModelsFailed}
									readOnly={step !== "model-choice"}
									selected={chosenModel}
								/>
							)}
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
