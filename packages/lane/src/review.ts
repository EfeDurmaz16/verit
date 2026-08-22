import { Effect, Either, JSONSchema, Schema as S } from "effect";
import { OUTPUT_STYLE, type RiskItem, type Understanding } from "@verit/domain";
import type { LaneClient, LaneRequest, LaneTool } from "./client";

/*
 * The review capability: turn the judge's located risks into findings that
 * survive a refutation, and drop the rest.
 *
 * The default lane summarizes: it produces the Understanding. "review" and
 * "both" add a co-equal reviewer. The judge hunts real, located risks over the
 * net diff, then a cheap skeptic tries to REFUTE each one from that same diff.
 * Only a finding the skeptic cannot refute survives.
 *
 * This is a FILTER that fails closed, never a gate that fabricates. A skeptic
 * error, timeout, refusal, or junk verdict DROPS the finding. A whole-judge
 * failure returns null upstream, so the lane stays honestly neutral with zero
 * findings. A failure never produces a finding and never dresses a run up.
 *
 * A finding is nothing new: it is a located reviewer RiskItem (source
 * "reviewer", a file, and a new-file line). The Check already renders those as
 * inline annotations, see packages/application/src/check.ts. This file reuses
 * risks[], it does not invent a parallel finding type.
 */

/** What the run asks of the lane. "understanding" is the summarize-only default
    that predates review; it stays byte-for-byte unchanged. "review" leans on
    finding hunting, "both" summarizes AND hunts. */
export type LaneMode = "understanding" | "review" | "both";

export const DEFAULT_LANE_MODE: LaneMode = "both";

/** Parse the mode env. Unknown or unset is the default: mode is a behavior knob,
    not a correctness one, so a typo softens nothing dangerous, it never fails
    the run. */
export const parseLaneMode = (raw: string | undefined): LaneMode =>
  raw === "understanding" || raw === "review" || raw === "both" ? raw : DEFAULT_LANE_MODE;

/** True when the mode runs the review pass: the finding hunt and the skeptic. */
export const modeReviews = (mode: LaneMode): boolean => mode !== "understanding";

/** The repo's own tests, as the lane learns of them. Threaded into the judge and
    skeptic prompts so a finding that asserts a runtime or test failure clears a
    higher bar when the tests already passed. */
export type ProofStatus = "passed" | "failed" | "neutral";

/* --------------------------------- verdict -------------------------------- */

export const SUBMIT_VERDICT_TOOL_NAME = "submit_verdict";

/**
 * One skeptic verdict on one finding. The skeptic must REFUTE the finding from
 * the net diff and default to is_real=false when the diff does not clearly
 * support it. A finding survives only when is_real is true AND confidence is
 * medium or high.
 */
export const Verdict = S.Struct({
  is_real: S.Boolean,
  confidence: S.Literal("low", "medium", "high"),
  reason: S.String,
});
export type Verdict = S.Schema.Type<typeof Verdict>;

const decodeVerdict = S.decodeUnknownEither(Verdict);

/** The verdict tool schema, generated from the Schema so the tool contract and
    the decode can never drift apart. Same trick as submit_understanding. */
export const verdictJsonSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(JSON.stringify(JSONSchema.make(Verdict))) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
};

const verdictTool = (): LaneTool => ({
  name: SUBMIT_VERDICT_TOOL_NAME,
  description:
    "Submit your verdict on the one finding above. Call exactly once. Default is_real to false when the net diff does not clearly support the finding.",
  inputSchema: verdictJsonSchema(),
});

/* --------------------------------- prompts -------------------------------- */

/*
 * ponytail: prompt-level proof grounding. The run's own test result is threaded
 * as plain context, not a classifier. Upgrade to a structured proof-vs-finding
 * cross-check (match a finding's asserted failure against the actual prove
 * suite result) later.
 */
const proofGroundingLine = (proof: ProofStatus): string =>
  proof === "passed"
    ? "The repo's own tests PASSED on this PR. A finding that asserts a runtime error or a test failure must clear a higher bar: point at the exact line, do not infer a failure the passing tests would have caught."
    : proof === "failed"
      ? "The repo's own tests FAILED on this PR. A finding that explains that failure is worth more than one unrelated to it."
      : "The repo's own tests were NEUTRAL on this PR: not run yet, or inconclusive. Judge findings on the diff alone.";

/**
 * The extra system-prompt block the judge gets when the mode reviews. It asks
 * for real, located findings in the SAME risks[] the Understanding already
 * carries: no new output shape, and the Understanding is never weakened.
 */
export const reviewInstructions = (mode: LaneMode, proof: ProofStatus): string =>
  `REVIEW PASS (mode: ${mode}). Besides the Understanding, hunt for real problems in the net diff and report each one as a risk in risks[].
- A review finding is a risk with source "reviewer", a file, a new-file line copied verbatim from the diff, and a severity.
- Report only what the diff shows: a bug, an unsafe path, a missing check, a broken contract. One finding per risk. No style nits, no praise, no "consider" padding.
- The file and line must point at a line this PR adds or changes, taken verbatim from the net diff above. If you cannot point at such a line, omit the file and line rather than guess one.
- ${proofGroundingLine(proof)}
- ${
    mode === "review"
      ? "Findings are the priority. Still fill what, why and how so the Understanding stays valid."
      : "Summarize AND hunt: the Understanding and the findings are both required."
  }`;

const skepticSystem = (proof: ProofStatus): string =>
  `You are a skeptical second reviewer. Another reviewer raised ONE finding about a pull request. REFUTE it, using the net diff below as the only ground truth.
Default to is_real=false. Mark is_real=true only when the diff clearly supports the finding at the cited line. A finding you cannot confirm from the diff is not real. When in doubt, refute.
${proofGroundingLine(proof)}

${OUTPUT_STYLE}

Call ${SUBMIT_VERDICT_TOOL_NAME} exactly once with your verdict, then stop.`;

const refuteUser = (risk: RiskItem, netDiff: string): string =>
  `FINDING to refute:
- area: ${risk.area}
- file: ${risk.file}
- line: ${risk.line}
- claim: ${risk.note}

NET DIFF (ground truth):
${netDiff}

Does the net diff at ${risk.file}:${risk.line} clearly support this finding? Refute it if not. Default to is_real=false.`;

/* --------------------------------- skeptic -------------------------------- */

/** Output cap for one verdict. A verdict is tiny; this bounds a runaway call. */
const SKEPTIC_MAX_TOKENS = 2_000;

/** Default per-call skeptic deadline. Each finding is verified under its own. */
export const DEFAULT_SKEPTIC_TIMEOUT_MS = 120_000;

const log = (message: string): void => console.error(`[verit-lane] ${message}`);

/**
 * Race a promise against a per-call deadline. Null means the clock won. The
 * underlying request is not cancelled: the client's own request timeout is the
 * socket backstop. Here we only stop waiting, then drop the finding.
 */
const withDeadline = async <T>(work: Promise<T>, ms: number): Promise<T | null> => {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(ms, 0));
  });
  try {
    return await Promise.race([work, clock]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One refute call. True only for a real finding the skeptic confirms with
 * medium or high confidence. Any error, timeout, refusal, missing verdict, or
 * junk returns false: the finding is dropped. Never throws. A synchronous throw
 * from the client is caught by the outer try; a defect or late rejection is
 * swallowed by the promise catch, so a timed-out call cannot surface as an
 * unhandled rejection.
 */
const survivesSkeptic = async (
  skeptic: LaneClient,
  risk: RiskItem,
  netDiff: string,
  proof: ProofStatus,
  timeoutMs: number,
): Promise<boolean> => {
  try {
    const request: LaneRequest = {
      system: skepticSystem(proof),
      messages: [{ role: "user", content: refuteUser(risk, netDiff) }],
      tools: [verdictTool()],
      maxTokens: SKEPTIC_MAX_TOKENS,
      forceTool: SUBMIT_VERDICT_TOOL_NAME,
    };
    const settle = Effect.runPromise(Effect.either(skeptic.complete(request)))
      .then((either) => (Either.isRight(either) ? either.right : null))
      .catch(() => null);
    const turn = await withDeadline(settle, timeoutMs);
    if (turn === null || turn.stopReason === "refusal") return false;
    const call = turn.toolCalls.find((c) => c.name === SUBMIT_VERDICT_TOOL_NAME);
    if (call === undefined) return false;
    const decoded = decodeVerdict(call.input);
    if (Either.isLeft(decoded)) return false;
    return decoded.right.is_real && decoded.right.confidence !== "low";
  } catch {
    return false;
  }
};

export interface VerifyFindingsOptions {
  readonly understanding: Understanding;
  /** The net diff the judge reviewed: the skeptic's ground truth. */
  readonly netDiff: string;
  /**
   * The PR head's changed lines, per new-file path. A located finding whose
   * (file, line) is not in here cited a line the head does not add, so it is
   * dropped, never verified against a line no one can see and never emitted with
   * a guessed location.
   */
  readonly changedLines: ReadonlyMap<string, ReadonlySet<number>>;
  readonly proofStatus: ProofStatus;
  /** Per-call skeptic deadline. Every finding is verified concurrently under it. */
  readonly timeoutMs?: number;
}

/**
 * Filter the judge's located findings through the skeptic.
 *
 * Every located reviewer risk (source "reviewer", a file, and a line the head
 * changed) gets ONE concurrent refute call, and survives only when the skeptic
 * confirms it is real with medium or high confidence. A located risk whose line
 * the head does not change is dropped as a guessed location, with no skeptic
 * call. Every other risk (an author hint, a whole-change reviewer risk with no
 * location, the coverage risk) passes through untouched.
 *
 * Returns the Understanding with risks replaced. Never throws: a broken skeptic
 * drops findings, it never keeps an unverified one and never invents one.
 */
export const verifyFindings = async (
  skeptic: LaneClient,
  options: VerifyFindingsOptions,
): Promise<Understanding> => {
  const { understanding, netDiff, changedLines, proofStatus } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SKEPTIC_TIMEOUT_MS;

  const kept = await Promise.all(
    understanding.risks.map(async (risk): Promise<RiskItem | null> => {
      // Not a located finding: an author hint or a whole-change risk. Untouched.
      if (risk.source !== "reviewer" || risk.file == null || risk.line == null) return risk;
      // A located finding must cite a line the PR head actually changed.
      if (!changedLines.get(risk.file)?.has(risk.line)) {
        log(`dropped a finding at ${risk.file}:${risk.line}: not a changed line in the PR head`);
        return null;
      }
      const survives = await survivesSkeptic(skeptic, risk, netDiff, proofStatus, timeoutMs);
      if (!survives) {
        log(`dropped a finding at ${risk.file}:${risk.line}: the skeptic did not confirm it`);
      }
      return survives ? risk : null;
    }),
  );

  return { ...understanding, risks: kept.filter((r): r is RiskItem => r !== null) };
};
