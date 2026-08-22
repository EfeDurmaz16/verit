import { Effect, Either, JSONSchema, Schema as S } from "effect";
import type { Understanding } from "@verit/domain";
import type { LaneClient, LaneRequest, LaneTool } from "./client";
import { runLane, type RunLaneInput } from "./loop";

/*
 * The tiered lane: an optional cheap map pass in front of the judge.
 *
 * The pipeline is deliberately blind to models. It never names one; it takes a
 * judge client and, when the tier has one, a triage client. Which slug each
 * client speaks to is decided in ./tiers and wired in ./index. Grep this file
 * for a model id and you will find none, on purpose.
 *
 * THE ONE INVARIANT: triage is an optimization, never a gate. If the map pass
 * fails, times out, or returns junk, the judge still runs on the FULL net diff.
 * A missing or wrong FocusPlan can only cost focus, never correctness. The
 * judge's own failure path is unchanged: an invalid or absent Understanding is
 * null, which the pipeline hands back for the honest-neutral path to handle.
 */

export const FOCUS_TOOL_NAME = "submit_focus_plan";

const FocusRegion = S.Struct({
  /** A path or hunk header taken verbatim from the net diff. */
  region: S.String,
  priority: S.Literal("high", "medium", "low"),
  /** One short line: why this region earns that priority. */
  why: S.String,
});

/** The map pass output: net diff regions ranked by review priority. Advisory. */
export const FocusPlan = S.Struct({
  regions: S.Array(FocusRegion),
});
export type FocusPlan = S.Schema.Type<typeof FocusPlan>;

const decodeFocusPlan = S.decodeUnknownEither(FocusPlan);

/** The focus-plan tool schema, generated from the Schema so the tool contract
    and the decode can never drift apart. Same trick as submit_understanding. */
export const focusPlanJsonSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(JSON.stringify(JSONSchema.make(FocusPlan))) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
};

const focusTool = (): LaneTool => ({
  name: FOCUS_TOOL_NAME,
  description:
    "Submit the focus plan: the net diff's regions ranked by review priority. Call exactly once. This is a map pass, not a judgement.",
  inputSchema: focusPlanJsonSchema(),
});

const TRIAGE_SYSTEM = `You are the map pass in front of a code review judge.
Read the net diff in the user message. Do NOT review it and do NOT judge it. Rank its regions by how much reviewer attention each deserves: which carry behaviour or risk, which are boilerplate to skim. Name each region by a path or a hunk header copied verbatim from the diff. Call ${FOCUS_TOOL_NAME} exactly once with the ranked plan, then stop. Keep it short.`;

const TRIAGE_MAX_TOKENS = 4_000;

const log = (message: string): void => console.error(`[verit-lane] ${message}`);

/**
 * The map pass. One model call, then decode. NEVER throws and NEVER fails the
 * lane: any error, timeout, missing plan, or invalid plan returns null, and the
 * judge falls back to the full net diff. The single call bounds its own cost:
 * one turn, TRIAGE_MAX_TOKENS out, and the client's own request timeout.
 */
export const runTriage = async (client: LaneClient, user: string): Promise<FocusPlan | null> => {
  try {
    const request: LaneRequest = {
      system: TRIAGE_SYSTEM,
      messages: [{ role: "user", content: user }],
      tools: [focusTool()],
      maxTokens: TRIAGE_MAX_TOKENS,
      forceTool: FOCUS_TOOL_NAME,
    };
    const outcome = await Effect.runPromise(Effect.either(client.complete(request)));
    if (Either.isLeft(outcome)) {
      log(`triage skipped, judging full net diff: ${outcome.left.message}`);
      return null;
    }
    const call = outcome.right.toolCalls.find((c) => c.name === FOCUS_TOOL_NAME);
    if (call === undefined) {
      log("triage returned no focus plan, judging full net diff");
      return null;
    }
    const decoded = decodeFocusPlan(call.input);
    if (Either.isLeft(decoded)) {
      log("triage focus plan was invalid, judging full net diff");
      return null;
    }
    return decoded.right;
  } catch (error) {
    log(`triage errored, judging full net diff: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};

/** Render a focus plan as advisory guidance appended to the judge's prompt. */
export const renderFocusPlan = (plan: FocusPlan): string => {
  const lines = plan.regions.map((r) => `- [${r.priority}] ${r.region}: ${r.why}`);
  return `FOCUS PLAN (advisory, from a fast map pass. Guidance only, not a filter. Review the whole net diff above. Trust the diff over this plan.):
${lines.join("\n")}`;
};

export interface TieredLaneInput extends RunLaneInput {
  /** The map-pass client, or null to skip triage and judge the full net diff. */
  readonly triageClient: LaneClient | null;
}

/**
 * Run the tiered lane: an optional triage map pass, then the judge loop. The
 * judge always sees the full net diff (input.user). A good FocusPlan is
 * appended as advisory focus; a failed or empty one changes nothing, so the
 * result is identical to judging the full diff with no triage at all.
 */
export const runTieredLane = async (
  judge: LaneClient,
  input: TieredLaneInput,
): Promise<Understanding | null> => {
  const { triageClient, ...judgeInput } = input;
  const plan = triageClient !== null ? await runTriage(triageClient, input.user) : null;
  const user =
    plan !== null && plan.regions.length > 0
      ? `${input.user}\n\n${renderFocusPlan(plan)}`
      : input.user;
  return runLane(judge, { ...judgeInput, user });
};
