import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { LaneError, type LaneClient, type LaneRequest, type LaneTurn } from "./client";
import { runLane } from "./loop";
import { laneUserPrompt, SUBMIT_TOOL_NAME } from "./prompt";
import { submitTool, understandingJsonSchema } from "./index";
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

const submitCall = (input: unknown) => ({
  id: "call_submit",
  name: SUBMIT_TOOL_NAME,
  input,
  inputJson: JSON.stringify(input),
});

const readCall = {
  id: "call_read",
  name: "read_file",
  input: { path: "a.ts" },
  inputJson: '{"path":"a.ts"}',
};

/** Scripted client: yields turns in order and records every request. */
const scripted = (
  turns: readonly LaneTurn[],
  requests: LaneRequest[] = [],
): LaneClient => {
  let i = 0;
  return {
    complete: (request) => {
      requests.push(request);
      const next = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return next === undefined
        ? Effect.fail(new LaneError("script exhausted"))
        : Effect.succeed(next);
    },
  };
};

const okExecutor = (): ToolOutcome => ({ content: "file body", isError: false });

describe("runLane", () => {
  it("runs a multi-turn tool conversation, then decodes the submitted Understanding", async () => {
    const requests: LaneRequest[] = [];
    const executed: Array<{ name: string; input: unknown }> = [];
    const client = scripted(
      [
        turn({ text: "Let me look.", toolCalls: [readCall], stopReason: "tool_use" }),
        turn({ toolCalls: [submitCall(SAMPLE)], stopReason: "tool_use" }),
      ],
      requests,
    );
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: (name, input) => {
        executed.push({ name, input });
        return { content: "file body", isError: false };
      },
    });
    expect(result?.what).toBe(SAMPLE.what);
    expect(result?.risks[0]?.source).toBe("reviewer");
    expect(executed).toEqual([{ name: "read_file", input: { path: "a.ts" } }]);
    // The second request replays the assistant turn and answers its tool call.
    const second = requests[1];
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[1]).toMatchObject({ role: "assistant" });
    expect(second?.messages[2]).toMatchObject({
      role: "tool_results",
      results: [{ toolCallId: "call_read", content: "file body" }],
    });
  });

  it("forces submit_understanding when the model stops without submitting", async () => {
    const requests: LaneRequest[] = [];
    const client = scripted(
      [
        turn({ text: "Analysis done.", stopReason: "end_turn" }),
        turn({ toolCalls: [submitCall(SAMPLE)], stopReason: "tool_use" }),
      ],
      requests,
    );
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result?.how).toBe(SAMPLE.how);
    expect(requests[0]?.forceTool).toBeUndefined();
    expect(requests[1]?.forceTool).toBe(SUBMIT_TOOL_NAME);
    const last = requests[1]?.messages.at(-1);
    expect(last).toMatchObject({ role: "user" });
  });

  it("normalizes em dashes through decodeUnderstanding", async () => {
    const withDash = { ...SAMPLE, what: "Adds a retry \u2014 the upload path needed one." };
    const client = scripted([turn({ toolCalls: [submitCall(withDash)], stopReason: "tool_use" })]);
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result?.what).toBe("Adds a retry, the upload path needed one.");
  });

  it("returns null when the turn cap is hit", async () => {
    const requests: LaneRequest[] = [];
    const client = scripted(
      [turn({ toolCalls: [readCall], stopReason: "tool_use" })],
      requests,
    );
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
      caps: { maxTurns: 2 },
    });
    expect(result).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("returns null when the wall clock cap is hit, without calling the model", async () => {
    const requests: LaneRequest[] = [];
    const client = scripted([turn({ toolCalls: [submitCall(SAMPLE)] })], requests);
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
      caps: { timeoutMs: 0 },
    });
    expect(result).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("returns null when the token cap is hit", async () => {
    const client = scripted([
      turn({
        toolCalls: [readCall],
        stopReason: "tool_use",
        usage: { inputTokens: 900, outputTokens: 200 },
      }),
    ]);
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
      caps: { maxTotalTokens: 1_000 },
    });
    expect(result).toBeNull();
  });

  it("returns null on an invalid submitted Understanding", async () => {
    const client = scripted([
      turn({ toolCalls: [submitCall({ what: "", why: "y", how: "h" })], stopReason: "tool_use" }),
    ]);
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result).toBeNull();
  });

  it("returns null on refusal", async () => {
    const client = scripted([turn({ stopReason: "refusal" })]);
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result).toBeNull();
  });

  it("returns null when the client fails with a non-retryable error", async () => {
    const client: LaneClient = {
      complete: () => Effect.fail(new LaneError("HTTP 401: bad key", 401, false)),
    };
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result).toBeNull();
  });

  it("retries once on a retryable error, then succeeds", async () => {
    let calls = 0;
    const client: LaneClient = {
      complete: () => {
        calls += 1;
        return calls === 1
          ? Effect.fail(new LaneError("HTTP 529: overloaded", 529, true))
          : Effect.succeed(turn({ toolCalls: [submitCall(SAMPLE)], stopReason: "tool_use" }));
      },
    };
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result?.what).toBe(SAMPLE.what);
    expect(calls).toBe(2);
  }, 10_000);

  it("answers truncated tool calls with error results, then forces submit", async () => {
    const requests: LaneRequest[] = [];
    const executed: string[] = [];
    const client = scripted(
      [
        turn({ toolCalls: [readCall], stopReason: "max_tokens" }),
        turn({ toolCalls: [submitCall(SAMPLE)], stopReason: "tool_use" }),
      ],
      requests,
    );
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: (name) => {
        executed.push(name);
        return { content: "x", isError: false };
      },
    });
    expect(result?.what).toBe(SAMPLE.what);
    expect(executed).toHaveLength(0);
    expect(requests[1]?.forceTool).toBe(SUBMIT_TOOL_NAME);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool_results",
      results: [{ toolCallId: "call_read", isError: true }],
    });
  });
});

describe("understanding tool schema", () => {
  it("mirrors the Effect Schema: required fields present, sample decodes", () => {
    const schema = understandingJsonSchema();
    expect(schema["type"]).toBe("object");
    const required = schema["required"];
    expect(required).toEqual(
      expect.arrayContaining(["what", "why", "how", "proof_refs", "risks"]),
    );
    expect(required).not.toContain("out_of_scope");
    const properties = schema["properties"] as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["what", "why", "how", "proof_refs", "out_of_scope", "risks"]),
    );
    expect(schema["$schema"]).toBeUndefined();
  });

  it("round-trips: a submit shaped by the schema decodes through the lane", async () => {
    const client = scripted([turn({ toolCalls: [submitCall(SAMPLE)], stopReason: "tool_use" })]);
    const result = await runLane(client, {
      system: "s",
      user: "u",
      tools: [],
      submitTool: submitTool(),
      executeTool: okExecutor,
    });
    expect(result).toMatchObject({
      what: SAMPLE.what,
      why: SAMPLE.why,
      how: SAMPLE.how,
    });
    expect(result?.proof_refs).toHaveLength(1);
  });
});

describe("laneUserPrompt", () => {
  const input = {
    title: "Move settle helpers",
    body: "Splits pay.ts.",
    paths: ["src/pay.ts", "src/settle.ts"],
    diff: [
      "diff --git a/src/pay.ts b/src/pay.ts",
      "--- a/src/pay.ts",
      "+++ b/src/pay.ts",
      "@@ -10,2 +10,0 @@",
      "-export const settle = (o) => ledger.post(o);",
      "-export const settled = (o) => ledger.has(o);",
      "diff --git a/src/settle.ts b/src/settle.ts",
      "--- a/src/settle.ts",
      "+++ b/src/settle.ts",
      "@@ -1,0 +1,3 @@",
      "+export const settle = (o) => ledger.post(o);",
      "+export const settled = (o) => ledger.has(o);",
      "+export const NEW_RETRY_LIMIT = 3;",
    ].join("\n"),
    context: { wiki_hits: [], pr_graph: [], domain: "PAYMENTS" as const },
    role: "review" as const,
  };

  it("feeds the net diff, same pre-pass as the pi lane", () => {
    const prompt = laneUserPrompt(input);
    expect(prompt).toContain("MOVE ANALYSIS");
    expect(prompt).toContain("NET DIFF, moves pre-factored");
    expect(prompt).toContain("NEW_RETRY_LIMIT");
  });

  it("falls back to the raw text when the input is not a unified diff", () => {
    const prompt = laneUserPrompt({ ...input, diff: "not a diff at all" });
    expect(prompt).toContain("UNIFIED DIFF");
    expect(prompt).toContain("not a diff at all");
  });
});
