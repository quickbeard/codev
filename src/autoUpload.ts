import { loadAuth } from "@/auth.js";

export interface ParsedAutoUploadArgs {
	agentArgs: string[];
	autoUpload: boolean;
}

// `codev <agent>` auto-uploads the resulting session by default. Users can
// opt out per-invocation with `--no-upload` (stripped before forwarding to
// the agent) or globally via the `CODEV_NO_AUTO_UPLOAD=1` env var.
export function parseAutoUploadFlag(args: string[]): ParsedAutoUploadArgs {
	const flagIdx = args.indexOf("--no-upload");
	const agentArgs =
		flagIdx === -1
			? args
			: [...args.slice(0, flagIdx), ...args.slice(flagIdx + 1)];
	const envDisabled = process.env.CODEV_NO_AUTO_UPLOAD === "1";
	const autoUpload = !envDisabled && flagIdx === -1;
	return { agentArgs, autoUpload };
}

// We only auto-upload when the user is already authenticated. Triggering
// the SSO browser flow as a side effect of exiting an agent session would
// be a surprising UX, so callers fall back to a one-line hint instead.
export function isAuthenticatedForUpload(): boolean {
	return loadAuth() !== null;
}
