import { Effect } from "effect";
import type { ClaimSources } from "@verit/domain";
import { describe, expect, it } from "vitest";
import { CLAIMS_TOOL_NAME, needsAuthorClaim, runClaimPass } from "./claims";
import { LaneError, type LaneClient, type LaneRequest, type LaneTurn } from "./client";

/*
 * The claim pass is where a review tool most easily starts lying: a model can
 * always produce a confident sentence about a diff. These tests hold the line
 * that the code, not the model, decides which sentences count.
 */

const SOURCES: ClaimSources = {
  issue: "The parser drops trailing commas in nested objects.",
  prDescription: "Fixes the trailing comma case in parse().",
  diff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n+  if (token === ',') continue;\n",
};

const turn = (partial: Partial<LaneTurn>): LaneTurn => ({
  text: null,
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
  ...partial,
});

const claimsTurn = (input: unknown): LaneTurn =>
  turn({
    toolCalls: [
      { id: "call_claims", name: CLAIMS_TOOL_NAME, input, inputJson: JSON.stringify(input) },
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

const anchored = {
  claims: [
    {
      statement: "Parsing a trailing comma no longer throws.",
      anchors: [
        { kind: "issue", ref: "#12", span: "drops trailing commas" },
        { kind: "diff", ref: "src/parse.ts", span: "if (token === ',') continue;" },
      ],
      confidence: 0.6,
      regions: ["src/parse.ts"],
    },
  ],
};

describe("runClaimPass grounds what the model proposes", () => {
  it("grounds a claim whose anchors resolve in the material", async () => {
    const claims = await runClaimPass(client({ turn: claimsTurn(anchored) }), SOURCES);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.state).toBe("source-grounded");
    expect(claims[0]?.statement).toBe("Parsing a trailing comma no longer throws.");
    expect(needsAuthorClaim(claims)).toBe(false);
  });

  it("marks a confidently invented quote ambiguous and asks the author", async () => {
    const fabricated = {
      claims: [
        {
          statement: "Rewrites the scheduler to be lock free.",
          anchors: [{ kind: "issue", ref: "#12", span: "rewrites the scheduler to be lock free" }],
          confidence: 1,
          regions: ["src/sched.ts"],
        },
      ],
    };
    const claims = await runClaimPass(client({ turn: claimsTurn(fabricated) }), SOURCES);
    expect(claims[0]?.state).toBe("ambiguous");
    expect(claims[0]?.modelConfidence).toBe(1);
    expect(needsAuthorClaim(claims)).toBe(true);
  });

  it("marks a claim with no anchors ambiguous", async () => {
    const unanchored = {
      claims: [
        {
          statement: "Makes the parser better.",
          anchors: [],
          confidence: 0.9,
          regions: [],
        },
      ],
    };
    const claims = await runClaimPass(client({ turn: claimsTurn(unanchored) }), SOURCES);
    expect(claims[0]?.state).toBe("ambiguous");
  });

  it("keeps the grounded claim and flags the fabricated one in the same batch", async () => {
    const mixed = {
      claims: [
        anchored.claims[0],
        {
          statement: "Also fixes the network layer.",
          anchors: [{ kind: "pr-description", ref: "body", span: "fixes the network layer" }],
          confidence: 0.95,
          regions: [],
        },
      ],
    };
    const claims = await runClaimPass(client({ turn: claimsTurn(mixed) }), SOURCES);
    expect(claims.map((c) => c.state)).toEqual(["source-grounded", "ambiguous"]);
    expect(needsAuthorClaim(claims)).toBe(true);
  });
});

describe("runClaimPass never invents a claim when it fails", () => {
  it("returns no claims when the model call fails", async () => {
    const claims = await runClaimPass(
      client({ fail: new LaneError("HTTP 500", 500) }),
      SOURCES,
    );
    expect(claims).toEqual([]);
    expect(needsAuthorClaim(claims)).toBe(true);
  });

  it("returns no claims when the client throws synchronously", async () => {
    const claims = await runClaimPass(client({ throws: true }), SOURCES);
    expect(claims).toEqual([]);
  });

  it("returns no claims when the model submitted nothing", async () => {
    const claims = await runClaimPass(client({ turn: turn({}) }), SOURCES);
    expect(claims).toEqual([]);
  });

  it("returns no claims when the submission does not decode", async () => {
    const claims = await runClaimPass(
      client({ turn: claimsTurn({ claims: [{ statement: 42 }] }) }),
      SOURCES,
    );
    expect(claims).toEqual([]);
  });

  it("accepts an honest empty submission", async () => {
    const claims = await runClaimPass(client({ turn: claimsTurn({ claims: [] }) }), SOURCES);
    expect(claims).toEqual([]);
    expect(needsAuthorClaim(claims)).toBe(true);
  });
});

describe("the claim pass is one bounded call", () => {
  it("forces the tool and reads only the material it was given", async () => {
    const seen: LaneRequest[] = [];
    await runClaimPass(client({ turn: claimsTurn(anchored), seen }), SOURCES);
    expect(seen).toHaveLength(1);
    const request = seen[0];
    expect(request?.forceTool).toBe(CLAIMS_TOOL_NAME);
    expect(request?.tools.map((t) => t.name)).toEqual([CLAIMS_TOOL_NAME]);
    const first = request?.messages[0];
    const user = first !== undefined && first.role === "user" ? first.content : "";
    expect(user).toContain("drops trailing commas");
    expect(user).toContain("if (token === ',') continue;");
  });
});
