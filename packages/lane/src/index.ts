import { Effect, JSONSchema } from "effect";
import { Understanding } from "@verit/domain";
import { changedHeadLines } from "@verit/netdiff";
import type { HarnessPort } from "@verit/ports";
import { StoreError } from "@verit/ports";
import { anthropicClient } from "./anthropic";
import { openLaneCheckout, stripProveWorkspaceCredentials } from "./checkout";
import type { LaneClient, LaneClientOptions, LaneTool } from "./client";
import { dropLaneHostSecrets, restoreLaneHostSecrets } from "./host-env";
import { DEFAULT_CAPS, type LaneCaps } from "./loop";
import { openaiCompatClient } from "./openai";
import { runTieredLane } from "./pipeline";
import { laneSystemPrompt, laneUserPrompt, SUBMIT_TOOL_NAME } from "./prompt";
import { type LaneMode, type ProofStatus, parseLaneMode } from "./review";
import { type LaneTier, parseLaneTier, resolveLaneTier } from "./tiers";
import { executeLaneTool, LANE_TOOLS } from "./tools";

/*
 * The harness-independent analysis lane: a thin agent loop over plain HTTP
 * model APIs. No codex, claude, or cursor CLI on this path.
 *
 * The operator picks a quality tier (fast, balanced, max), not a model. The
 * tier resolves to slugs in ./tiers, the one place a model id is written. A
 * tier may add a cheap triage map pass in front of the judge; ./pipeline runs
 * it as an optimization that can never change or block the result. A legacy
 * single pin (VERIT_LANE_MODEL) means one model, one pass: it moves the judge
 * and suppresses triage, so an existing single-model setup keeps making the
 * exact same one call it always did.
 */

export type LaneProvider = "anthropic" | "openai-compat";

export interface LaneConfig {
  readonly provider: LaneProvider;
  readonly tier: LaneTier;
  /** What the run asks of the lane: understanding, review, or both. */
  readonly mode: LaneMode;
  /** The judge slug that produces the Understanding. */
  readonly judge: string;
  /** The optional triage slug for the map pass. Absent means a single call. */
  readonly triage?: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly caps: LaneCaps;
  /** Workspace root the tools run in. */
  readonly root: string;
}

/** The lane runs the moment a provider is named. */
export const laneEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.VERIT_LANE_PROVIDER !== undefined && env.VERIT_LANE_PROVIDER !== "";

const intFromEnv = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Resolve the lane config. Misconfiguration throws: an operator who opted in
 * by naming a provider gets a loud error, never a silent neutral run. The judge
 * slug comes from the tier. VERIT_LANE_MODEL, when set, is a legacy single pin:
 * it overrides the judge AND suppresses triage, so the run is one model and one
 * pass, exactly what a pre-tier single-model setup did. To keep a tier's triage
 * with a custom judge, override the per-tier judge slug instead.
 */
export const laneConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): LaneConfig => {
  const provider = env.VERIT_LANE_PROVIDER;
  if (provider !== "anthropic" && provider !== "openai-compat") {
    throw new Error(
      `VERIT_LANE_PROVIDER must be "anthropic" or "openai-compat", got "${provider ?? ""}"`,
    );
  }
  const tier = parseLaneTier(env.VERIT_LANE_TIER);
  const mode = parseLaneMode(env.VERIT_LANE_MODE);
  const resolved = resolveLaneTier(tier, env);
  // A legacy single pin is one model, one pass: it moves the judge and drops
  // triage, so an existing single-model setup never fires a second (and, on a
  // native provider, cross-provider and doomed) triage call it never asked for.
  const pin = env.VERIT_LANE_MODEL;
  const pinned = pin !== undefined && pin !== "";
  const judge = pinned ? pin : resolved.judge;
  const triage = pinned ? undefined : resolved.triage;
  const apiKey =
    env.VERIT_LANE_API_KEY ??
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (apiKey === undefined || apiKey === "") {
    const fallbackVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`no lane API key: set VERIT_LANE_API_KEY or ${fallbackVar}`);
  }
  return {
    provider,
    tier,
    mode,
    judge,
    ...(triage !== undefined ? { triage } : {}),
    apiKey,
    baseUrl: env.VERIT_LANE_BASE_URL || undefined,
    caps: {
      maxTurns: intFromEnv(env.VERIT_LANE_MAX_TURNS, DEFAULT_CAPS.maxTurns),
      timeoutMs: intFromEnv(env.VERIT_LANE_TIMEOUT_MS, DEFAULT_CAPS.timeoutMs),
      maxTotalTokens: intFromEnv(env.VERIT_LANE_MAX_TOTAL_TOKENS, DEFAULT_CAPS.maxTotalTokens),
    },
    root: env.VERIT_PROVE_CWD || env.GITHUB_WORKSPACE || process.cwd(),
  };
};

/**
 * The submit tool's schema is generated from the Effect Schema itself, so the
 * contract the model is forced to fill and the contract decodeUnderstanding
 * checks can never drift apart.
 */
export const understandingJsonSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(JSON.stringify(JSONSchema.make(Understanding))) as Record<
    string,
    unknown
  >;
  delete schema["$schema"];
  return schema;
};

export const submitTool = (): LaneTool => ({
  name: SUBMIT_TOOL_NAME,
  description:
    "Submit the final Understanding of this pull request. Call exactly once, when the analysis is complete. This ends the run.",
  inputSchema: understandingJsonSchema(),
});

/** Build a client for one slug on the configured provider. Every model call in
    a run, judge or triage, goes through here. */
export const clientForModel = (config: LaneConfig, model: string): LaneClient => {
  const options: LaneClientOptions = {
    apiKey: config.apiKey,
    model,
    baseUrl: config.baseUrl,
    // One request can never outlive the whole lane.
    requestTimeoutMs: config.caps.timeoutMs,
  };
  return config.provider === "anthropic" ? anthropicClient(options) : openaiCompatClient(options);
};

/** The judge client for this config. Kept as the single-client entry point. */
export const laneClientFor = (config: LaneConfig): LaneClient =>
  clientForModel(config, config.judge);

/**
 * HarnessPort over the thin lane. Config errors fail the effect loudly;
 * runtime failures (HTTP, caps, refusal, invalid output) return null, the
 * honest "analysis did not complete" the pipeline already handles.
 */
export const makeLaneHarness = (config?: LaneConfig): HarnessPort => ({
  runUnderstand: (input) =>
    Effect.tryPromise({
      try: async () => {
        const cfg = config ?? laneConfigFromEnv();
        const judge = clientForModel(cfg, cfg.judge);
        const triageClient = cfg.triage !== undefined ? clientForModel(cfg, cfg.triage) : null;
        // ponytail: prove runs AFTER understand (see runUnderstandPipeline in
        // packages/cli/src/main.ts), so the run has no proof result at lane
        // time: it is neutral here. The prompt and skeptic already take a
        // ProofStatus, so a later reordering or a proof-vs-finding cross-check
        // can pass the real result without touching this plumbing.
        const proofStatus: ProofStatus = "neutral";
        // Drop host tokens from process.env for the tool window. The CLI also
        // re-execs without them so /proc/self/environ is already clean.
        dropLaneHostSecrets();
        try {
          // Strip persist-credentials extraheader on the prove cwd before
          // tools run. Lane bash can read VERIT_PROVE_CWD from the parent
          // environ and git-config that path.
          stripProveWorkspaceCredentials(process.env, cfg.root);
          // Tools run in an isolated checkout of HEAD, never the tree prove
          // measures, so the lane cannot mutate its way to a green check.
          const checkout = openLaneCheckout(cfg.root);
          try {
            return await runTieredLane(judge, {
              system: laneSystemPrompt(input.role, cfg.mode, proofStatus),
              user: laneUserPrompt(input),
              tools: LANE_TOOLS,
              submitTool: submitTool(),
              executeTool: (name, toolInput) => executeLaneTool(checkout.root, name, toolInput),
              caps: cfg.caps,
              triageClient,
              mode: cfg.mode,
              proofStatus,
              // A located finding must cite a line this PR head changes. The
              // Check anchors annotations to the same set (changedHeadLines).
              changedLines: changedHeadLines(input.diff),
            });
          } finally {
            checkout.cleanup();
          }
        } finally {
          restoreLaneHostSecrets();
        }
      },
      catch: (e) => new StoreError("lane harness understand", e),
    }),
});

export { anthropicClient } from "./anthropic";
export { openaiCompatClient } from "./openai";
export { runLane, DEFAULT_CAPS } from "./loop";
export type { LaneCaps, RunLaneInput } from "./loop";
export {
  DEFAULT_LANE_TIER,
  LANE_TIERS,
  parseLaneTier,
  resolveLaneTier,
} from "./tiers";
export type { LaneTier, LaneTierModels } from "./tiers";
export {
  FocusPlan,
  FOCUS_TOOL_NAME,
  renderFocusPlan,
  runTieredLane,
  runTriage,
} from "./pipeline";
export type { TieredLaneInput } from "./pipeline";
export {
  DEFAULT_LANE_MODE,
  DEFAULT_SKEPTIC_TIMEOUT_MS,
  modeReviews,
  parseLaneMode,
  reviewInstructions,
  SUBMIT_VERDICT_TOOL_NAME,
  Verdict,
  verdictJsonSchema,
  verifyFindings,
} from "./review";
export type { LaneMode, ProofStatus, VerifyFindingsOptions } from "./review";
export { laneSystemPrompt, laneUserPrompt, SUBMIT_TOOL_NAME } from "./prompt";
export { openLaneCheckout, stripCheckoutCredentialConfig, stripProveWorkspaceCredentials } from "./checkout";
export type { LaneCheckout } from "./checkout";
export { executeLaneTool, laneChildEnv, LANE_TOOLS, truncateResult, TOOL_RESULT_CHARS } from "./tools";
export type { ToolOutcome } from "./tools";
export {
  dropLaneHostSecrets,
  ensureLaneHostScrubbed,
  LANE_HOST_SECRET_KEYS,
  restoreLaneHostSecrets,
  takeLaneHostSecrets,
} from "./host-env";
export type { LaneHostSecretKey, LaneHostSecrets } from "./host-env";
export { LaneError } from "./client";
export type {
  LaneClient,
  LaneClientOptions,
  LaneMessage,
  LaneRequest,
  LaneStopReason,
  LaneTool,
  LaneToolCall,
  LaneToolResult,
  LaneTurn,
  LaneUsage,
} from "./client";
export { CLAIMS_TOOL_NAME, claimsJsonSchema, needsAuthorClaim, renderClaimSources, runClaimPass } from "./claims";
export type { ClaimSubmission } from "./claims";
