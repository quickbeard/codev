import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useState } from "react";
import type { AuthMethodChoice } from "@/components/AuthMethod.js";
import { AuthMethod, authMethodTitle } from "@/components/AuthMethod.js";
import { Banner } from "@/components/Banner.js";
import { Configure, configureTitle } from "@/components/Configure.js";
import { Confirm, confirmTitle } from "@/components/Confirm.js";
import { Frame } from "@/components/Frame.js";
import { Install } from "@/components/Install.js";
import { Login, loginTitle } from "@/components/Login.js";
import {
	ManualCredentials,
	type ManualCredentialsValue,
	manualCredentialsTitle,
} from "@/components/ManualCredentials.js";
import { Step } from "@/components/Step.js";
import { ToolSelect, toolSelectTitle } from "@/components/ToolSelect.js";
import { type ApiKeyCreds, loadApiKey, saveApiKey } from "@/lib/auth.js";
import type { Credentials, Tool } from "@/lib/configure.js";
import { validateApiKey } from "@/lib/proxy.js";

type Phase =
	| "select"
	| "confirm"
	| "installing"
	| "install-failed"
	| "validating-existing"
	| "auth-method"
	| "login"
	| "manual-creds"
	| "configuring"
	| "configure-failed"
	| "done";

const POST_VALIDATE: Phase[] = [
	"auth-method",
	"login",
	"manual-creds",
	"configuring",
	"configure-failed",
	"done",
];
const POST_AUTH_METHOD: Phase[] = [
	"login",
	"manual-creds",
	"configuring",
	"configure-failed",
	"done",
];
const POST_AUTH: Phase[] = ["configuring", "configure-failed", "done"];

export function InstallApp() {
	const { exit } = useApp();
	const [step, setStep] = useState<Phase>("select");
	const [tools, setTools] = useState<Tool[]>([]);
	const [authMethod, setAuthMethod] = useState<AuthMethodChoice | null>(null);
	const [creds, setCreds] = useState<Credentials | null>(null);
	const [fallenBack, setFallenBack] = useState(false);
	const [savedCreds, setSavedCreds] = useState<ApiKeyCreds | null>(null);
	const [existingValid, setExistingValid] = useState(false);
	const [existingMessage, setExistingMessage] = useState<string | null>(null);

	const handleConfirm = (selected: Tool[]) => {
		setTools(selected);
		setStep("confirm");
	};

	const handleConfirmProceed = useCallback(
		(proceed: boolean) => {
			if (!proceed) {
				exit();
				return;
			}
			setStep("installing");
		},
		[exit],
	);

	// On failure we set a terminal `*-failed` phase and stop advancing. The
	// step's error frame stays rendered so the user can read it; exiting the
	// app is left to the user (Ctrl-C), matching Login/Configure's prior
	// hang-on-error behavior.
	const handleInstallDone = useCallback((success: boolean) => {
		if (!success) {
			setStep("install-failed");
			return;
		}
		const saved = loadApiKey();
		if (!saved) {
			setStep("auth-method");
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
				setStep("auth-method");
			});
	}, []);

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
				setStep("configuring");
				return;
			}
			setStep(choice === "sso" ? "login" : "manual-creds");
		},
		[savedCreds],
	);

	const handleLoginDone = useCallback((key: string) => {
		setCreds({ apiKey: key });
		setStep("configuring");
	}, []);

	const handleLoginFallback = useCallback(() => {
		setFallenBack(true);
		setStep("manual-creds");
	}, []);

	const handleManualDone = useCallback((value: ManualCredentialsValue) => {
		saveApiKey({
			apiKey: value.apiKey,
			baseUrl: value.baseUrl,
			model: value.model,
		});
		setCreds({
			apiKey: value.apiKey,
			baseUrl: value.baseUrl,
			model: value.model,
		});
		setStep("configuring");
	}, []);

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
					<Step
						active={step === "installing"}
						title={<Text bold>Installing packages</Text>}
					>
						<Install tools={tools} onDone={handleInstallDone} />
					</Step>
				)}
				{(step === "validating-existing" || POST_VALIDATE.includes(step)) &&
					savedCreds && (
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
						active={step === "auth-method"}
						title={authMethodTitle(step !== "auth-method")}
					>
						<AuthMethod
							onSelect={handleAuthMethod}
							readOnly={step !== "auth-method"}
							selected={authMethod}
							hasExisting={existingValid}
						/>
					</Step>
				)}
				{POST_AUTH_METHOD.includes(step) && authMethod === "sso" && (
					<Step active={step === "login"} title={loginTitle()}>
						<Login onDone={handleLoginDone} onFallback={handleLoginFallback} />
					</Step>
				)}
				{POST_AUTH_METHOD.includes(step) &&
					(authMethod === "manual" || fallenBack) && (
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
				{POST_AUTH.includes(step) && creds && (
					<Step active={step === "configuring"} title={configureTitle()}>
						<Configure
							tools={tools}
							creds={creds}
							onDone={handleConfigureDone}
						/>
					</Step>
				)}
			</Frame>
		</Box>
	);
}
