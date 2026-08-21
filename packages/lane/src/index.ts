import { Effect, JSONSchema } from "effect";
import { Understanding } from "@verit/domain";
import type { HarnessPort } from "@verit/ports";
import { StoreError } from "@verit/ports";
import { anthropicClient } from "./anthropic";
import { openLaneCheckout, stripProveWorkspaceCredentials } from "./checkout";
import type { LaneClient, LaneTool } from "./client";
import { dropLaneHostSecrets, restoreLaneHostSecrets } from "./host-env";
import { DEFAULT_CAPS, runLane, type LaneCaps } from "./loop";
import { openaiCompatClient } from "./openai";
import { laneSystemPrompt, laneUserPrompt, SUBMIT_TOOL_NAME } from "./prompt";
import { executeLaneTool, LANE_TOOLS } from "./tools";

/*
 * The harness-independent analysis lane: a thin agent loop over plain HTTP
 * model APIs. No codex, claude, or cursor CLI on this path. The model is
 * always pinned by the operator (VERIT_LANE_MODEL); there is no silent
 * fallback, because a lane that silently switches models cannot be trusted to
 * review security-relevant diffs.
 */

export type LaneProvider = "anthropic" | "openai-compat";

export interface LaneConfig {
  readonly provider: LaneProvider;
  readonly model: string;
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
 * by naming a provider gets a loud error, never a silent neutral run.
 */
export const laneConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): LaneConfig => {
  const provider = env.VERIT_LANE_PROVIDER;
  if (provider !== "anthropic" && provider !== "openai-compat") {
    throw new Error(
      `VERIT_LANE_PROVIDER must be "anthropic" or "openai-compat", got "${provider ?? ""}"`,
    );
  }
  const model = env.VERIT_LANE_MODEL;
  if (model === undefined || model === "") {
    throw new Error(
      "VERIT_LANE_MODEL is required: the lane always pins its model, it never guesses one",
    );
  }
  const apiKey =
    env.VERIT_LANE_API_KEY ??
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (apiKey === undefined || apiKey === "") {
    const fallbackVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`no lane API key: set VERIT_LANE_API_KEY or ${fallbackVar}`);
  }
  return {
    provider,
    model,
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

export const laneClientFor = (config: LaneConfig): LaneClient => {
  const options = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    // One request can never outlive the whole lane.
    requestTimeoutMs: config.caps.timeoutMs,
  };
  return config.provider === "anthropic" ? anthropicClient(options) : openaiCompatClient(options);
};

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
        const client = laneClientFor(cfg);
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
            return await runLane(client, {
              system: laneSystemPrompt(input.role),
              user: laneUserPrompt(input),
              tools: LANE_TOOLS,
              submitTool: submitTool(),
              executeTool: (name, toolInput) => executeLaneTool(checkout.root, name, toolInput),
              caps: cfg.caps,
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
