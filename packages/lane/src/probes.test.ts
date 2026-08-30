import { Effect } from "effect";
import type { Claim } from "@verit/domain";
import { describe, expect, it } from "vitest";
import { LaneError, type LaneClient, type LaneRequest, type LaneTurn } from "./client";
import {
  PROBE_BATCH_TOOL_NAME,
  PROBE_TOOL_NAME,
  type ProbeContext,
  runProbeBatch,
  runProbePass,
  toProbeSpec,
} from "./probes";

const claim: Claim = {
  id: "c1",
  statement: "Parsing a trailing comma no longer throws.",
  state: "source-grounded",
  anchors: [{ kind: "diff", ref: "src/parse.ts", span: "if (token === ',') continue;" }],
  modelConfidence: 0.7,
  regions: ["src/parse.ts"],
};

const ctx: ProbeContext = {
  claim,
  netDiff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n+  if (token === ',') continue;\n",
  repoContext: "TypeScript, vitest, source in src/",
  existingTests: ["src/parse.test.ts"],
};

const turn = (partial: Partial<LaneTurn>): LaneTurn => ({
  text: null,
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
  ...partial,
});

const probeTurn = (input: unknown): LaneTurn =>
  turn({
    toolCalls: [
      { id: "call_probe", name: PROBE_TOOL_NAME, input, inputJson: JSON.stringify(input) },
    ],
    stopReason: "tool_use",
  });

const client = (behavior: {
  readonly turn?: LaneTurn;
  readonly fail?: LaneError;
  readonly throws?: boolean;
  readonly seen?: LaneRequest[];
}): LaneClient => ({
  complete: (request: LaneRequest) => {
    behavior.seen?.push(request);
    if (behavior.throws === true) throw new Error("client exploded");
    if (behavior.fail !== undefined) return Effect.fail(behavior.fail);
    return Effect.succeed(behavior.turn ?? turn({}));
  },
});

const valid = {
  probes: [
    {
      source: "import {parse} from './src/parse.ts'; parse('{a:1,}'); process.exit(0);",
      fileName: "probe.mjs",
      command: "node",
      args: ["{probe}"],
      asserts: "parse accepts a trailing comma without throwing",
    },
  ],
};

describe("runProbePass writes a probe or says it cannot", () => {
  it("returns the submitted probe", async () => {
    const probes = await runProbePass(client({ turn: probeTurn(valid) }), ctx);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.asserts).toContain("trailing comma");
  });

  it("accepts an honest empty submission", async () => {
    const probes = await runProbePass(client({ turn: probeTurn({ probes: [] }) }), ctx);
    expect(probes).toEqual([]);
  });

  it("returns nothing when the call fails", async () => {
    expect(await runProbePass(client({ fail: new LaneError("HTTP 500", 500) }), ctx)).toEqual([]);
  });

  it("returns nothing when the client throws", async () => {
    expect(await runProbePass(client({ throws: true }), ctx)).toEqual([]);
  });

  it("returns nothing when the model submitted no tool call", async () => {
    expect(await runProbePass(client({ turn: turn({}) }), ctx)).toEqual([]);
  });

  it("returns nothing when the submission does not decode", async () => {
    const probes = await runProbePass(
      client({ turn: probeTurn({ probes: [{ source: 42 }] }) }),
      ctx,
    );
    expect(probes).toEqual([]);
  });

  it("tells the model what the repository already tests, so it does not repeat one", async () => {
    const seen: LaneRequest[] = [];
    await runProbePass(client({ turn: probeTurn(valid), seen }), ctx);
    const first = seen[0]?.messages[0];
    const user = first !== undefined && first.role === "user" ? first.content : "";
    expect(user).toContain("src/parse.test.ts");
    expect(user).toContain("Parsing a trailing comma no longer throws.");
    expect(seen[0]?.forceTool).toBe(PROBE_TOOL_NAME);
  });
});

describe("a generated probe cannot describe itself as one of the repository's own", () => {
  it("fixes the origin to generated whatever the model said", async () => {
    const lying = {
      probes: [
        {
          ...valid.probes[0],
          // the schema has no origin field, so this is simply dropped
          origin: "repo-native",
        },
      ],
    };
    const probes = await runProbePass(client({ turn: probeTurn(lying) }), ctx);
    const spec = toProbeSpec(probes[0]!, "p-gen-1");
    expect(spec.origin).toBe("generated");
  });

  it("takes its kind from the caller, never from the model", async () => {
    // The model used to be asked whether a claim was about new behavior and
    // said yes every time. The diff already answers it, so the caller does.
    const probes = await runProbePass(client({ turn: probeTurn(valid) }), ctx);
    expect(toProbeSpec(probes[0]!, "p-gen-1").kind).toBe("behavioral");
    expect(toProbeSpec(probes[0]!, "p-gen-1", "precondition").kind).toBe("precondition");
  });

  it("ignores a targetsNewBehavior the model volunteers anyway", async () => {
    const volunteered = {
      probes: [{ ...valid.probes[0], targetsNewBehavior: true }],
    };
    const probes = await runProbePass(client({ turn: probeTurn(volunteered) }), ctx);
    expect(toProbeSpec(probes[0]!, "p1").kind).toBe("behavioral");
  });

  it("carries an installPath only when the model asked for one", async () => {
    const probes = await runProbePass(client({ turn: probeTurn(valid) }), ctx);
    expect(toProbeSpec(probes[0]!, "p1").installPath).toBeUndefined();

    const installed = {
      probes: [{ ...valid.probes[0], installPath: "src/generated.test.ts" }],
    };
    const withPath = await runProbePass(client({ turn: probeTurn(installed) }), ctx);
    expect(toProbeSpec(withPath[0]!, "p1").installPath).toBe("src/generated.test.ts");
  });

  it("drops an empty installPath rather than installing at the repo root", async () => {
    const empty = { probes: [{ ...valid.probes[0], installPath: "" }] };
    const probes = await runProbePass(client({ turn: probeTurn(empty) }), ctx);
    expect(toProbeSpec(probes[0]!, "p1").installPath).toBeUndefined();
  });
});

describe("the writer is told how this repository runs", () => {
  it("names the suites, the invocation and the working directory", async () => {
    const seen: LaneRequest[] = [];
    await runProbePass(client({ turn: probeTurn(valid), seen }), {
      ...ctx,
      runtime: {
        suites: ["pnpm run test"],
        invocation: "node {probe}",
        cwd: "packages/cli",
      },
    });
    const first = seen[0]?.messages[0];
    const user = first !== undefined && first.role === "user" ? first.content : "";
    expect(user).toContain("pnpm run test");
    expect(user).toContain("node {probe}");
    expect(user).toContain("packages/cli");
    expect(user).toContain("You may start processes");
  });

  it("says nothing about running when it was told nothing", async () => {
    const seen: LaneRequest[] = [];
    await runProbePass(client({ turn: probeTurn(valid), seen }), ctx);
    const first = seen[0]?.messages[0];
    const user = first !== undefined && first.role === "user" ? first.content : "";
    expect(user).not.toContain("HOW THIS REPOSITORY RUNS");
  });
});

describe("one call for every claim", () => {
  const ctxFor = (id: string): ProbeContext => ({
    ...ctx,
    claim: { ...claim, id, statement: `claim ${id}` },
  });

  const batchTurn = (input: unknown): LaneTurn =>
    turn({
      toolCalls: [
        {
          id: "call_batch",
          name: PROBE_BATCH_TOOL_NAME,
          input,
          inputJson: JSON.stringify(input),
        },
      ],
      stopReason: "tool_use",
    });

  it("keeps each probe under the claim it belongs to", async () => {
    const out = await runProbeBatch(
      client({
        turn: batchTurn({
          entries: [
            { claimId: "c1", probes: valid.probes },
            { claimId: "c2", probes: valid.probes },
          ],
        }),
      }),
      [ctxFor("c1"), ctxFor("c2")],
    );
    expect([...out.keys()].sort()).toEqual(["c1", "c2"]);
    expect(out.get("c1")).toHaveLength(1);
  });

  it("asks once, whatever the number of claims", async () => {
    const seen: LaneRequest[] = [];
    await runProbeBatch(client({ turn: batchTurn({ entries: [] }), seen }), [
      ctxFor("c1"),
      ctxFor("c2"),
      ctxFor("c3"),
    ]);
    expect(seen).toHaveLength(1);
    const first = seen[0]?.messages[0];
    const user = first !== undefined && first.role === "user" ? first.content : "";
    for (const id of ["c1", "c2", "c3"]) expect(user).toContain(`===== CLAIM ${id} =====`);
  });

  it("drops a probe attributed to a claim nobody asked about", async () => {
    const out = await runProbeBatch(
      client({
        turn: batchTurn({
          entries: [
            { claimId: "c1", probes: valid.probes },
            { claimId: "invented", probes: valid.probes },
          ],
        }),
      }),
      [ctxFor("c1")],
    );
    expect([...out.keys()]).toEqual(["c1"]);
  });

  it("accepts an honest empty list for a claim it could not answer", async () => {
    const out = await runProbeBatch(
      client({ turn: batchTurn({ entries: [{ claimId: "c1", probes: [] }] }) }),
      [ctxFor("c1")],
    );
    expect(out.get("c1")).toEqual([]);
  });

  it("returns nothing when the call fails, never an invented probe", async () => {
    const out = await runProbeBatch(client({ fail: new LaneError("HTTP 500", 500) }), [
      ctxFor("c1"),
    ]);
    expect(out.size).toBe(0);
  });

  it("returns nothing when the output does not decode", async () => {
    const out = await runProbeBatch(client({ turn: batchTurn({ entries: [{ claimId: 7 }] }) }), [
      ctxFor("c1"),
    ]);
    expect(out.size).toBe(0);
  });

  it("does not call the model at all for no claims", async () => {
    const seen: LaneRequest[] = [];
    const out = await runProbeBatch(client({ turn: batchTurn({ entries: [] }), seen }), []);
    expect(seen).toEqual([]);
    expect(out.size).toBe(0);
  });
});
