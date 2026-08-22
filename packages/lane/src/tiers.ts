/*
 * Lane quality tiers: the one knob a user turns.
 *
 * A tier is a promise about the review ("fast", "balanced", "max"), never a
 * model name. The slugs each tier maps to live ONLY in this file (and the
 * README's tier matrix), so no model id is ever inlined in the pipeline logic
 * and swapping a model is a config edit, not a code change. Every slug is
 * env-overridable, so an operator can pin a different model without a release.
 *
 * Defaults are OpenRouter slugs, verified live against
 * https://openrouter.ai/api/v1/models on 2026-08-22. OpenRouter is the
 * recommended path: one key, any model, one openai-compat base URL.
 */

export type LaneTier = "fast" | "balanced" | "max";

export const LANE_TIERS: readonly LaneTier[] = ["fast", "balanced", "max"];

export const DEFAULT_LANE_TIER: LaneTier = "balanced";

/** The models one tier resolves to. `triage` absent means a single judge call. */
export interface LaneTierModels {
  /** Optional cheap big-context map pass. Absent on the fast tier. */
  readonly triage?: string;
  /** The judge that produces the Understanding. Always present. */
  readonly judge: string;
}

/*
 * The default slug table. This is the ONLY place in the code a model id is
 * written down. Every entry is overridable per the env vars below.
 *
 *  - triage and the fast judge: openai/gpt-5.6-luna, a cheap fast 1M-context
 *    model, so the map pass can hold a large diff and cost almost nothing.
 *  - balanced judge: anthropic/claude-sonnet-5.
 *  - max judge: anthropic/claude-opus-5.
 */
const FAST_JUDGE = "openai/gpt-5.6-luna";
const TRIAGE_MODEL = "openai/gpt-5.6-luna";
const BALANCED_JUDGE = "anthropic/claude-sonnet-5";
const MAX_JUDGE = "anthropic/claude-opus-5";

const DEFAULTS: Record<LaneTier, LaneTierModels> = {
  fast: { judge: FAST_JUDGE },
  balanced: { triage: TRIAGE_MODEL, judge: BALANCED_JUDGE },
  max: { triage: TRIAGE_MODEL, judge: MAX_JUDGE },
};

/**
 * Parse the tier env. Unknown or unset falls back to the default. A tier is a
 * quality knob, not a correctness one, so a typo softens the review, it never
 * fails the run.
 */
export const parseLaneTier = (raw: string | undefined): LaneTier =>
  raw === "fast" || raw === "balanced" || raw === "max" ? raw : DEFAULT_LANE_TIER;

const envOverride = (
  env: NodeJS.ProcessEnv,
  tier: LaneTier,
  slot: "JUDGE" | "TRIAGE",
): string | undefined => {
  const value = env[`VERIT_LANE_TIER_${tier.toUpperCase()}_${slot}`];
  return value !== undefined && value !== "" ? value : undefined;
};

/**
 * Resolve one tier to its models, applying env overrides. The judge is always
 * present. The triage stays absent unless the tier has one, or an operator adds
 * one with VERIT_LANE_TIER_<TIER>_TRIAGE.
 */
export const resolveLaneTier = (
  tier: LaneTier,
  env: NodeJS.ProcessEnv = process.env,
): LaneTierModels => {
  const base = DEFAULTS[tier];
  const judge = envOverride(env, tier, "JUDGE") ?? base.judge;
  const triage = envOverride(env, tier, "TRIAGE") ?? base.triage;
  return triage !== undefined ? { triage, judge } : { judge };
};
