import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Understanding } from "@verit/domain";
import { LaneError, type LaneClient, type LaneRequest, type LaneTurn } from "./client";
import { SUBMIT_VERDICT_TOOL_NAME, verifyFindings } from "./review";

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
