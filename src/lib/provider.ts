import { loadApiKey } from "@/lib/auth.js";

// The provider identity CoDev writes into every OpenAI-compatible agent config:
// `id` is the config key (Codex `model_provider` / `[model_providers.<id>]`,
// OpenCode `provider.<id>` and its `"<id>/<model>"` reference), `name` is the
// human-readable label the agent shows in its model picker.
export interface ProviderIdentity {
	id: string;
	name: string;
}

// SSO-issued keys ("Get a new API Key", and "Reuse existing API Key" when the
// saved key carries no provider of its own) — "netgate" / "netGate".
const DEFAULT_PROVIDER: ProviderIdentity = {
	id: atob("bmV0Z2F0ZQ=="),
	name: atob("bmV0R2F0ZQ=="),
};

// The manual path's fallback, used when the user leaves the provider name blank
// or types something that yields no usable id — "ai-gateway" / "AI Gateway".
const MANUAL_PROVIDER: ProviderIdentity = {
	id: atob("YWktZ2F0ZXdheQ=="),
	name: atob("QUkgR2F0ZXdheQ=="),
};

// Pre-rename installs wrote this id — "aigateway". Kept purely so detection
// (and the base_url readback) still recognizes configs written before the
// netGate rename; nothing writes it any more.
const LEGACY_PROVIDER_ID = atob("YWlnYXRld2F5");

// Provider ids end up as TOML bare keys (`[model_providers.<id>]`) and as the
// left half of OpenCode's `"<id>/<model>"` string, so the slug is restricted to
// [a-z0-9-]: no quoting rules to reason about, and no slash to split on.
const MAX_ID_LENGTH = 32;

export function defaultProvider(): ProviderIdentity {
	return DEFAULT_PROVIDER;
}

// Returns "" when the name yields nothing usable (e.g. all punctuation), which
// callers read as "fall back to the default identity".
export function slugifyProviderName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_ID_LENGTH)
		.replace(/-+$/, "");
}

// Manual path: turn what the user typed into the pair we persist and write.
// A blank or unusable name falls back to AI Gateway / ai-gateway.
export function providerFromName(name: string): ProviderIdentity {
	const id = slugifyProviderName(name);
	if (!id) return MANUAL_PROVIDER;
	return { id, name: name.trim() };
}

// Configure-time resolution. Credentials carry a provider only when they came
// from the manual path (or from a saved manual key being reused); everything
// else is an SSO-issued key and gets the netGate default.
export function resolveProvider(creds: {
	providerId?: string;
	providerName?: string;
}): ProviderIdentity {
	if (!creds.providerId) return DEFAULT_PROVIDER;
	return { id: creds.providerId, name: creds.providerName || creds.providerId };
}

// Every provider id that means "CoDev wrote this config": the one saved for the
// current key (manual installs), plus the built-ins. Used by the authorship
// detectors and the base_url readers, which can no longer look for a single
// compile-time key.
//
// When auth.json is missing a custom id is unattributable, so a custom-provider
// config reads as user-authored — restore keeps it rather than deleting it,
// which is the conservative direction this module has always taken.
export function codevProviderIds(): string[] {
	const saved = loadApiKey()?.providerId;
	const ids = [DEFAULT_PROVIDER.id, MANUAL_PROVIDER.id, LEGACY_PROVIDER_ID];
	if (saved && !ids.includes(saved)) ids.unshift(saved);
	return ids;
}
