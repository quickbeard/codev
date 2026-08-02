import { loadModelLimits } from "@/lib/auth.js";

// Per-model context windows and auto-compaction triggers.
//
// Every agent CoDev configures needs to be told the window of the model it's
// talking to — the gateway serves custom models none of them recognize, so
// each would otherwise guess (Codex assumes 272K, OpenCode assumes 0, which
// disables compaction outright). This module is the single source of truth for
// those numbers; the four writers in lib/configure.ts translate them into each
// agent's own knob and hold no window constants of their own.

export interface ModelLimits {
	// The model's true window. Written verbatim wherever an agent wants "how big
	// is this model" — including OpenCode's `limit.context`, which drives the
	// TUI's "% context used" gauge, so understating it here would misreport
	// every session.
	context: number;
	// Where auto-compaction should fire. Deliberately explicit rather than a
	// percentage of `context`: the gap between the two is a judgement call per
	// model, not a constant.
	trigger: number;
	// Max output tokens. Absent ⇒ DEFAULT_OUTPUT_TOKENS.
	output?: number;
}

// Max output tokens advertised to agents that require one alongside a window.
export const DEFAULT_OUTPUT_TOKENS = 65536;

// OpenCode's `compaction.reserved` — a single global token buffer, with no
// per-model variant in its config schema. See declaredInput() for how a shared
// reserve still yields exact per-model triggers.
export const COMPACT_RESERVED = 40000;

// Percentage used to derive a trigger from a window we didn't pick ourselves,
// i.e. one reported by the gateway. Table entries state their trigger outright.
export const DEFAULT_COMPACT_PCT = 80;

// Unrecognized models are treated as 200K-class. Chosen over the older 196608
// default because it matches the smaller of the two models actually served,
// and because guessing low is the safe direction: too small a window wastes
// capacity, too large overruns the model and 400s mid-session.
export const DEFAULT_LIMITS: ModelLimits = { context: 200000, trigger: 160000 };

// Known gateway models. Keyed by the exact id `/v1/models` reports, which is
// what lands in every agent config.
//
// MiniMax/MiniMax-M2.7 is deliberately absent: DEFAULT_LIMITS already describes
// it correctly, and an entry that merely restates the default is one more thing
// to keep in sync.
const TABLE: Record<string, ModelLimits> = {
	"MiniMax/MiniMax-M3": { context: 1000000, trigger: 800000 },
	"zai-org/GLM-4.7-cc": { context: 200000, trigger: 160000 },
};

// Windows reported by the gateway, cached in auth.json by the model-choice
// step. Read once per process: configure* runs several times per command (one
// call per selected agent, and once per model in the OpenCode models map) and
// none of them can change the file mid-run.
let remoteCache: Record<string, ModelLimits> | null | undefined;

function remoteLimits(): Record<string, ModelLimits> | null {
	if (remoteCache === undefined) remoteCache = loadModelLimits();
	return remoteCache;
}

// Test seam: lets a test install (or clear) the remote map without writing
// auth.json and without the once-per-process cache leaking across cases.
export function resetModelLimitsCache(): void {
	remoteCache = undefined;
}

// Resolve one model's limits. Precedence is remote → table → default: the
// gateway is authoritative about its own models when it says anything at all,
// and the table exists to carry the models it currently reports nothing for.
export function limitsFor(modelId: string): ModelLimits {
	const remote = remoteLimits()?.[modelId];
	if (remote) return remote;
	return TABLE[modelId] ?? DEFAULT_LIMITS;
}

// Turn a gateway-reported window into full limits. Exported for backend.ts,
// which has the raw max_input_tokens/max_output_tokens and no opinion about
// where the trigger belongs.
export function limitsFromWindow(
	context: number,
	output?: number,
): ModelLimits {
	return {
		context,
		trigger: Math.round((context * DEFAULT_COMPACT_PCT) / 100),
		...(output ? { output } : {}),
	};
}

// Claude Code takes a window plus a percentage, so the trigger is expressed as
// a share of the window. Integer percent, so a trigger that isn't a whole
// percentage of its window lands within half a percent of the intent.
export function compactPct(limits: ModelLimits): number {
	return Math.round((limits.trigger / limits.context) * 100);
}

// OpenCode's trigger is `limit.input − compaction.reserved`, falling back to
// `limit.context − maxOutputTokens` when `limit.input` is absent — in which
// case `reserved` is computed and then discarded. So `input` is what makes the
// reserve authoritative, and it is the only per-model lever over a trigger that
// otherwise shares one global reserve across every model in the config.
//
// Solving `input − reserved = trigger` gives `input = trigger + reserved`, which
// lands each model's trigger exactly on target regardless of what the others
// need. `context` stays truthful.
//
// Clamped to the true window: `trigger + reserved` above `context` would
// overstate the budget and let a session run past the model's real ceiling
// before compacting. Clamping can only move a trigger earlier, never later, so
// a bad table entry degrades into early compaction rather than 400s.
export function declaredInput(limits: ModelLimits): number {
	return Math.min(limits.trigger + COMPACT_RESERVED, limits.context);
}

export function outputTokens(limits: ModelLimits): number {
	return limits.output ?? DEFAULT_OUTPUT_TOKENS;
}
