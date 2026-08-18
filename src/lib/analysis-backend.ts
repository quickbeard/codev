import {
	ANALYSIS_BACKEND_ANON_KEY,
	ANALYSIS_BACKEND_URL,
} from "@/lib/const.js";

export interface AnalysisBackendConfig {
	url: string;
	anonKey: string;
}

// Reads the analysis backend coordinates the CoDev backend provisioned at the
// last successful SSO login. Both accessors hard-fail with a "run codevhub
// install" message if the values aren't on disk, so callers don't need their
// own missing-config branch.
export function getAnalysisBackendConfig(): AnalysisBackendConfig {
	return {
		url: ANALYSIS_BACKEND_URL().replace(/\/+$/, ""),
		anonKey: ANALYSIS_BACKEND_ANON_KEY(),
	};
}
