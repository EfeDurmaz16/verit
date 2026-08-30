import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Understanding } from "@verit/domain";
import { LaneError, type LaneClient, type LaneRequest, type LaneTurn } from "./client";
import { DEFAULT_LANE_MODE, parseLaneMode, SUBMIT_VERDICT_TOOL_NAME, verifyFindings } from "./review";
import { FOCUS_TOOL_NAME, runTieredLane } from "./pipeline";
import { laneSystemPrompt, SUBMIT_TOOL_NAME } from "./prompt";
import { submitTool } from "./index";
import type { ToolOutcome } from "./tools";

/*
 * The honesty invariants of the review pass, on a fake skeptic, no live HTTP.
 * A finding is a located reviewer risk; the skeptic is a filter that fails
 * closed. These tests assert what survives the filter and, more importantly,
 * what is dropped.
 */

const BASE_U: Understanding = {
  what: "Adds a retry to the upload path.",
  why: "Uploads failed on transient 503s.",
  how: "Wraps uploadRun in one retry.",
  proof_refs: [],
  risks: [],
};

/** A located reviewer finding: source reviewer, a file, a new-file line. */
const finding = (
  file: string,
  line: number,
  over: Partial<Understanding["risks"][number]> = {},
): Understanding["risks"][number] => ({
  area: "auth",
  note: `unguarded path at ${file}:${line}`,
  source: "reviewer",
  file,
  line,
  severity: "high",
  ...over,
});

const withRisks = (risks: Understanding["risks"]): Understanding => ({ ...BASE_U, risks });

const changed = (spec: Record<string, readonly number[]>): Map<string, Set<number>> =>
  new Map(Object.entries(spec).map(([p, ls]) => [p, new Set(ls)]));

const turn = (partial: Partial<LaneTurn>): LaneTurn => ({
  text: null,
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
  ...partial,
});

const verdictTurn = (input: unknown): LaneTurn =>
  turn({
    toolCalls: [
      { id: "call_v", name: SUBMIT_VERDICT_TOOL_NAME, input, inputJson: JSON.stringify(input) },
    ],
    stopReason: "tool_use",
  });

const userOf = (req: LaneRequest): string => {
  const m = req.messages[0];
  return m !== undefined && m.role === "user" ? m.content : "";
};

/** A skeptic whose verdict is decided from the finding in the refute prompt. */
const skepticThat = (decide: (user: string) => unknown): LaneClient => ({
  complete: (req) => Effect.succeed(verdictTurn(decide(userOf(req)))),
});

const REAL_HIGH = { is_real: true, confidence: "high", reason: "the diff supports it" };
const FALSE_HIGH = { is_real: false, confidence: "high", reason: "the diff does not support it" };

describe("verifyFindings: the skeptic is a filter that fails closed", () => {
  it("drops a planted false finding the skeptic refutes, keeps the one it confirms", async () => {
    // Two located findings. The skeptic confirms line 10, refutes line 20.
    const u = withRisks([finding("src/a.ts", 10), finding("src/a.ts", 20)]);
    const skeptic = skepticThat((user) => (user.includes(":20") ? FALSE_HIGH : REAL_HIGH));
    const out = await verifyFindings(skeptic, {
      understanding: u,
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10, 20] }),
      proofStatus: "neutral",
    });
    expect(out.risks).toHaveLength(1);
    expect(out.risks[0]?.line).toBe(10);
  });

  it("drops a finding whose line the head does not change, without calling the skeptic", async () => {
    const calls: string[] = [];
    const skeptic: LaneClient = {
      complete: (req) => {
        calls.push(userOf(req));
        return Effect.succeed(verdictTurn(REAL_HIGH));
      },
    };
    // line 99 is not a changed line: a guessed location, dropped up front.
    const out = await verifyFindings(skeptic, {
      understanding: withRisks([finding("src/a.ts", 99)]),
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10, 42] }),
      proofStatus: "neutral",
    });
    expect(out.risks).toEqual([]);
    expect(calls).toEqual([]); // never verified a line we cannot see
  });

  it("drops the finding whose skeptic call throws, and keeps the other verified findings", async () => {
    const u = withRisks([finding("src/a.ts", 10), finding("src/a.ts", 20)]);
    const skeptic: LaneClient = {
      complete: (req) =>
        userOf(req).includes(":20")
          ? Effect.fail(new LaneError("HTTP 500: boom", 500, false))
          : Effect.succeed(verdictTurn(REAL_HIGH)),
    };
    const out = await verifyFindings(skeptic, {
      understanding: u,
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10, 20] }),
      proofStatus: "neutral",
    });
    expect(out.risks).toHaveLength(1);
    expect(out.risks[0]?.line).toBe(10);
  });

  it("drops a finding when the skeptic client throws synchronously (never rethrows)", async () => {
    const skeptic: LaneClient = {
      complete: () => {
        throw new Error("sync boom before the effect even runs");
      },
    };
    const out = await verifyFindings(skeptic, {
      understanding: withRisks([finding("src/a.ts", 10)]),
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10] }),
      proofStatus: "neutral",
    });
    expect(out.risks).toEqual([]);
  });

  it("drops a finding the skeptic marks real but only low confidence", async () => {
    const out = await verifyFindings(
      skepticThat(() => ({ is_real: true, confidence: "low", reason: "maybe" })),
      {
        understanding: withRisks([finding("src/a.ts", 10)]),
        netDiff: "NET DIFF",
        changedLines: changed({ "src/a.ts": [10] }),
        proofStatus: "neutral",
      },
    );
    expect(out.risks).toEqual([]);
  });

  it("drops a finding whose verdict is junk (fails the Verdict decode)", async () => {
    const out = await verifyFindings(skepticThat(() => ({ not: "a verdict" })), {
      understanding: withRisks([finding("src/a.ts", 10)]),
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10] }),
      proofStatus: "neutral",
    });
    expect(out.risks).toEqual([]);
  });

  it("drops a finding whose skeptic call times out", async () => {
    const hang: LaneClient = {
      complete: () => Effect.promise(() => new Promise<LaneTurn>(() => {})),
    };
    const out = await verifyFindings(hang, {
      understanding: withRisks([finding("src/a.ts", 10)]),
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10] }),
      proofStatus: "neutral",
      timeoutMs: 10,
    });
    expect(out.risks).toEqual([]);
  });

  it("passes author hints and unlocated reviewer risks through untouched", async () => {
    // A skeptic that would refute everything it is asked about.
    const skeptic = skepticThat(() => FALSE_HIGH);
    const risks: Understanding["risks"] = [
      { area: "author", note: "the author admits this", source: "author", file: "src/a.ts", line: 10 },
      { area: "coverage", note: "reviewed 60% of the diff", source: "reviewer" },
    ];
    const out = await verifyFindings(skeptic, {
      understanding: withRisks(risks),
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10] }),
      proofStatus: "neutral",
    });
    // The author hint and the unlocated reviewer risk are not findings: kept.
    expect(out.risks).toEqual(risks);
  });

  it("leaves what, why and how intact while filtering risks", async () => {
    const out = await verifyFindings(skepticThat(() => FALSE_HIGH), {
      understanding: withRisks([finding("src/a.ts", 10)]),
      netDiff: "NET DIFF",
      changedLines: changed({ "src/a.ts": [10] }),
      proofStatus: "neutral",
    });
    expect(out.what).toBe(BASE_U.what);
    expect(out.why).toBe(BASE_U.why);
    expect(out.how).toBe(BASE_U.how);
    expect(out.risks).toEqual([]); // the one finding was refuted and dropped
  });
});

/*
 * The review pass wired into the tiered lane: mode gates whether the skeptic
 * runs, the skeptic reuses the cheap triage client when there is one, and a
 * judge that fails still yields null (honest neutral, zero findings).
 */

const submitTurn = (input: unknown): LaneTurn =>
  turn({
    toolCalls: [
      { id: "call_submit", name: SUBMIT_TOOL_NAME, input, inputJson: JSON.stringify(input) },
    ],
    stopReason: "tool_use",
  });

const focusTurn = (): LaneTurn =>
  turn({
    toolCalls: [
      {
        id: "call_focus",
        name: FOCUS_TOOL_NAME,
        input: { regions: [] },
        inputJson: '{"regions":[]}',
      },
    ],
    stopReason: "tool_use",
  });

/** A client that answers by the tool it is forced to call, and records each
    force so a test can prove which pass invoked it. */
const clientByForce = (
  answers: { focus?: LaneTurn; verdict?: unknown; submit?: unknown },
  forces: string[] = [],
): LaneClient => ({
  complete: (req: LaneRequest) => {
    forces.push(req.forceTool ?? "none");
    if (req.forceTool === FOCUS_TOOL_NAME) return Effect.succeed(answers.focus ?? focusTurn());
    if (req.forceTool === SUBMIT_VERDICT_TOOL_NAME) return Effect.succeed(verdictTurn(answers.verdict));
    return Effect.succeed(submitTurn(answers.submit));
  },
});

/** A judge that yields scripted turns in order (last repeats). Lets one judge
    client answer the submit call then the skeptic call in fast tier. */
const scripted = (turns: readonly LaneTurn[], forces: string[] = []): LaneClient => {
  let i = 0;
  return {
    complete: (req: LaneRequest) => {
      forces.push(req.forceTool ?? "none");
      const next = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return next === undefined ? Effect.fail(new LaneError("script exhausted")) : Effect.succeed(next);
    },
  };
};

const okExecutor = (): ToolOutcome => ({ content: "file body", isError: false });

const laneInput = (over: Partial<Parameters<typeof runTieredLane>[1]> = {}) => ({
  system: "s",
  user: "NET DIFF",
  tools: [],
  submitTool: submitTool(),
  executeTool: okExecutor,
  triageClient: null,
  ...over,
});

describe("runTieredLane review wiring", () => {
  it("mode understanding is byte for byte today: no review prompt, no skeptic", async () => {
    // The prompt for understanding mode equals the pre-review prompt exactly.
    expect(laneSystemPrompt("review", "understanding")).toBe(laneSystemPrompt("review"));
    expect(laneSystemPrompt("review", "understanding")).not.toContain("REVIEW PASS");

    // A judge that would love to see its finding survive: in understanding mode
    // the skeptic never runs, so the finding is returned untouched and the judge
    // is the only call.
    const forces: string[] = [];
    const judge = clientByForce({ submit: withRisks([finding("src/a.ts", 10)]) }, forces);
    const out = await runTieredLane(judge, laneInput({ mode: "understanding" }));
    expect(out?.risks).toHaveLength(1);
    expect(out?.risks[0]?.line).toBe(10);
    expect(forces).toEqual(["none"]); // one judge call, never a forced verdict
  });

  it("mode both keeps a valid Understanding and drops a finding the skeptic refutes", async () => {
    const forces: string[] = [];
    const skepticTriage = clientByForce({ verdict: FALSE_HIGH }, forces);
    const judge = clientByForce({ submit: withRisks([finding("src/a.ts", 10)]) });
    const out = await runTieredLane(
      judge,
      laneInput({
        mode: "both",
        triageClient: skepticTriage,
        changedLines: changed({ "src/a.ts": [10] }),
      }),
    );
    // The Understanding stays valid, only the refuted finding is gone.
    expect(out?.what).toBe(BASE_U.what);
    expect(out?.risks).toEqual([]);
    // The triage client ran the map pass AND the skeptic refute call.
    expect(forces).toEqual([FOCUS_TOOL_NAME, SUBMIT_VERDICT_TOOL_NAME]);
  });

  it("mode both keeps a finding the skeptic confirms, and the skeptic reuses triage", async () => {
    const skepticTriage = clientByForce({ verdict: REAL_HIGH });
    const judge = clientByForce({ submit: withRisks([finding("src/a.ts", 10)]) });
    const out = await runTieredLane(
      judge,
      laneInput({
        mode: "both",
        triageClient: skepticTriage,
        changedLines: changed({ "src/a.ts": [10] }),
      }),
    );
    expect(out?.risks).toHaveLength(1);
    expect(out?.risks[0]?.line).toBe(10);
  });

  it("the skeptic falls back to the judge client when the tier has no triage", async () => {
    // fast tier: triageClient null. The judge answers the submit, then the same
    // client answers the forced verdict and refutes.
    const forces: string[] = [];
    const judge = scripted(
      [submitTurn(withRisks([finding("src/a.ts", 10)])), verdictTurn(FALSE_HIGH)],
      forces,
    );
    const out = await runTieredLane(
      judge,
      laneInput({ mode: "review", triageClient: null, changedLines: changed({ "src/a.ts": [10] }) }),
    );
    expect(out?.risks).toEqual([]);
    expect(forces).toEqual(["none", SUBMIT_VERDICT_TOOL_NAME]); // judge, then judge-as-skeptic
  });

  it("a judge failure is null in review mode: honest neutral, zero findings, no skeptic", async () => {
    const forces: string[] = [];
    const judge: LaneClient = {
      complete: (req: LaneRequest) => {
        forces.push(req.forceTool ?? "none");
        return Effect.fail(new LaneError("HTTP 401: bad key", 401, false));
      },
    };
    const out = await runTieredLane(judge, laneInput({ mode: "both" }));
    expect(out).toBeNull();
    expect(forces).not.toContain(SUBMIT_VERDICT_TOOL_NAME); // no finding fabricated
  });

  it("an invalid Understanding is null in review mode, never a fabricated finding", async () => {
    const judge = clientByForce({ submit: { what: "", why: "y", how: "h" } });
    const out = await runTieredLane(judge, laneInput({ mode: "both" }));
    expect(out).toBeNull();
  });
});

/*
 * The mode default. action.yml exports VERIT_LANE_MODE="" when the input is
 * unset, so the empty string is the real production default path: it must review
 * by default, and a typo must never silently disable the reviewer.
 */
describe("parseLaneMode: the default reviews, a typo never disables review", () => {
  it("unset, empty, and unknown all resolve to the reviewing default (both)", () => {
    expect(DEFAULT_LANE_MODE).toBe("both");
    expect(parseLaneMode(undefined)).toBe("both"); // env unset
    expect(parseLaneMode("")).toBe("both"); // action.yml empty export
    expect(parseLaneMode("REVIEW")).toBe("both"); // case-sensitive: softens to review, not off
    expect(parseLaneMode("understand")).toBe("both"); // a typo never lands on understanding-only
    expect(parseLaneMode("nonsense")).toBe("both");
  });

  it("each valid mode round-trips exactly", () => {
    expect(parseLaneMode("understanding")).toBe("understanding");
    expect(parseLaneMode("review")).toBe("review");
    expect(parseLaneMode("both")).toBe("both");
  });
});
