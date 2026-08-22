import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LaneError, type LaneClient, type LaneRequest, type LaneTurn } from "./client";
import { submitTool } from "./index";
import { runTieredLane } from "./pipeline";
import { SUBMIT_TOOL_NAME } from "./prompt";
import { FOCUS_TOOL_NAME } from "./pipeline";
import type { ToolOutcome } from "./tools";

const SAMPLE = {
  what: "Adds one retry to the upload path.",
  why: "Uploads failed on transient 503s.",
  how: "Wraps uploadRun in a single retry inside packages/cli/src/upload.ts.",
  proof_refs: [{ kind: "command", label: "unit tests", value: "pnpm test" }],
  out_of_scope: ["No backoff tuning."],
  risks: [{ area: "retry", note: "A duplicate upload can happen on timeout.", source: "reviewer" }],
};

const turn = (partial: Partial<LaneTurn>): LaneTurn => ({
  text: null,
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
  ...partial,
});

const submitTurn = (input: unknown): LaneTurn =>
  turn({
    toolCalls: [{ id: "call_submit", name: SUBMIT_TOOL_NAME, input, inputJson: JSON.stringify(input) }],
    stopReason: "tool_use",
  });

const focusTurn = (input: unknown): LaneTurn =>
  turn({
    toolCalls: [{ id: "call_focus", name: FOCUS_TOOL_NAME, input, inputJson: JSON.stringify(input) }],
    stopReason: "tool_use",
  });

const VALID_PLAN = {
  regions: [{ region: "packages/cli/src/upload.ts", priority: "high", why: "the retry lives here" }],
};

interface Call {
  readonly label: string;
  readonly request: LaneRequest;
}

/** The first user message a recorded call carried. Narrows the union, no cast. */
const userOf = (call: Call | undefined): string => {
  const msg = call?.request.messages[0];
  return msg !== undefined && msg.role === "user" ? msg.content : "";
};

/** A client that records every request under a label and replays one turn, or
    fails with a LaneError when `fail` is set. */
const recorder = (
  label: string,
  behavior: { readonly turn?: LaneTurn; readonly fail?: LaneError },
  log: Call[],
): LaneClient => ({
  complete: (request) => {
    log.push({ label, request });
    if (behavior.fail !== undefined) return Effect.fail(behavior.fail);
    return Effect.succeed(behavior.turn ?? turn({}));
  },
});

const okExecutor = (): ToolOutcome => ({ content: "file body", isError: false });

const runInput = (triageClient: LaneClient | null) => ({
  system: "s",
  user: "NET DIFF here",
  tools: [],
  submitTool: submitTool(),
  executeTool: okExecutor,
  triageClient,
});

describe("runTieredLane call counting", () => {
  it("fast tier makes exactly ONE model call, the judge", async () => {
    const log: Call[] = [];
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(null));
    expect(result?.what).toBe(SAMPLE.what);
    expect(log.map((c) => c.label)).toEqual(["judge"]);
  });

  it("balanced or max makes TWO calls: triage then judge, and focuses the judge", async () => {
    const log: Call[] = [];
    const triage = recorder("triage", { turn: focusTurn(VALID_PLAN) }, log);
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(triage));
    expect(result?.what).toBe(SAMPLE.what);
    // Order matters: the map pass runs before the judge.
    expect(log.map((c) => c.label)).toEqual(["triage", "judge"]);
    // The judge sees the full net diff PLUS the focus plan.
    const judgeUser = userOf(log[1]);
    expect(judgeUser).toContain("NET DIFF here");
    expect(judgeUser).toContain("FOCUS PLAN");
    expect(judgeUser).toContain("packages/cli/src/upload.ts");
  });
});

describe("triage is an optimization, never a gate", () => {
  it("a throwing triage falls back to the SAME Understanding judged on the full diff", async () => {
    const baseline: Call[] = [];
    const judgeAlone = recorder("judge", { turn: submitTurn(SAMPLE) }, baseline);
    const fromFullDiff = await runTieredLane(judgeAlone, runInput(null));

    const log: Call[] = [];
    const triage = recorder("triage", { fail: new LaneError("HTTP 500: boom", 500, false) }, log);
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const withBrokenTriage = await runTieredLane(judge, runInput(triage));

    // Same honest result, never null-because-of-triage.
    expect(withBrokenTriage).toEqual(fromFullDiff);
    expect(withBrokenTriage?.what).toBe(SAMPLE.what);
    // The judge ran on the plain net diff, no focus injected.
    const judgeUser = userOf(log[1]);
    expect(judgeUser).toBe("NET DIFF here");
    expect(judgeUser).not.toContain("FOCUS PLAN");
  });

  it("an invalid triage plan falls back to judging the full diff", async () => {
    const log: Call[] = [];
    const triage = recorder("triage", { turn: focusTurn({ not: "a plan" }) }, log);
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(triage));
    expect(result?.what).toBe(SAMPLE.what);
    expect(userOf(log[1])).toBe("NET DIFF here");
  });

  it("a triage that submits no focus plan falls back to judging the full diff", async () => {
    const log: Call[] = [];
    const triage = recorder("triage", { turn: turn({ text: "no plan", stopReason: "end_turn" }) }, log);
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(triage));
    expect(result?.what).toBe(SAMPLE.what);
  });
});

describe("judge failure still returns null for the neutral path", () => {
  it("an invalid submitted Understanding is null, triage or not", async () => {
    const log: Call[] = [];
    const triage = recorder("triage", { turn: focusTurn(VALID_PLAN) }, log);
    const judge = recorder("judge", { turn: submitTurn({ what: "", why: "y", how: "h" }) }, log);
    const result = await runTieredLane(judge, runInput(triage));
    expect(result).toBeNull();
  });

  it("a failed judge call is null", async () => {
    const log: Call[] = [];
    const judge = recorder("judge", { fail: new LaneError("HTTP 401: bad key", 401, false) }, log);
    const result = await runTieredLane(judge, runInput(null));
    expect(result).toBeNull();
  });
});

describe("triage failure is always a fallback, never a null or a dropped risk", () => {
  const judgeUserOf = (log: Call[]): string => userOf(log.find((c) => c.label === "judge"));

  it("a triage client that throws synchronously falls back to the full-diff judgment", async () => {
    const log: Call[] = [];
    const throwing: LaneClient = {
      complete: () => {
        throw new Error("sync boom before the effect even runs");
      },
    };
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(throwing));
    // Never null because of triage; the judge ran on the plain net diff.
    expect(result?.what).toBe(SAMPLE.what);
    expect(judgeUserOf(log)).toBe("NET DIFF here");
  });

  it("a triage effect that dies (a defect, not a typed LaneError) falls back too", async () => {
    const log: Call[] = [];
    const dying: LaneClient = {
      // Effect.either only catches the typed error channel, not defects, so this
      // proves runTriage's own try/catch is the real backstop, not Either alone.
      complete: () => Effect.die(new Error("defect, uncaught error channel")),
    };
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(dying));
    expect(result?.what).toBe(SAMPLE.what);
    expect(judgeUserOf(log)).toBe("NET DIFF here");
  });

  it("a valid but empty focus plan injects no focus and judges the plain diff", async () => {
    const log: Call[] = [];
    const triage = recorder("triage", { turn: focusTurn({ regions: [] }) }, log);
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    const result = await runTieredLane(judge, runInput(triage));
    // regions:[] decodes fine but carries no guidance, so nothing is appended.
    expect(result?.what).toBe(SAMPLE.what);
    expect(judgeUserOf(log)).toBe("NET DIFF here");
  });
});

describe("triage is a single bounded call that cannot burn the judge budget", () => {
  it("triage forces exactly the focus tool, bounds its tokens, and never sees the workspace or submit tools", async () => {
    const log: Call[] = [];
    const triage = recorder("triage", { turn: focusTurn(VALID_PLAN) }, log);
    const judge = recorder("judge", { turn: submitTurn(SAMPLE) }, log);
    await runTieredLane(judge, runInput(triage));
    const triageReq = log.find((c) => c.label === "triage")?.request;
    expect(triageReq).toBeDefined();
    // One forced call to the map-pass tool and nothing else: triage cannot loop
    // through workspace tools or submit an Understanding, so it can spend
    // neither the judge's turn budget nor its token budget.
    expect(triageReq?.forceTool).toBe(FOCUS_TOOL_NAME);
    expect(triageReq?.tools.map((t) => t.name)).toEqual([FOCUS_TOOL_NAME]);
    // Triage output is capped, so even a runaway map pass is bounded on its own.
    expect(triageReq?.maxTokens ?? 0).toBeGreaterThan(0);
    expect(triageReq?.maxTokens ?? Infinity).toBeLessThanOrEqual(8_000);
  });
});
