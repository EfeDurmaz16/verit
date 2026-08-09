import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { agentCli, agentPrompt, extractUnderstanding } from "./agent";
import { makeAgentHarness } from "./index";

const INPUT = {
  title: "Reject unlisted mints before quoting",
  body: "## Summary\nMerchants were charged in tokens they cannot settle.\n",
  paths: ["src/pay.ts", "src/quote.ts"],
  diff: "--- a/src/pay.ts\n+++ b/src/pay.ts\n+ if (!allowlist.has(mint)) throw new Error('unlisted');\n",
  context: {
    wiki_hits: [{ pageId: "w1", title: "Settlement", excerpt: "supported mints", score: 1 }],
    pr_graph: [
      {
        number: 12,
        title: "Add allowlist",
        edgeKind: "linked" as const,
        inferred: false,
        prId: "pr:solana-foundation/pay#12",
        blurb: "introduced the mint allowlist",
      },
    ],
    domain: "PAYMENTS" as const,
    focus: "SECURITY" as const,
  },
  role: "review" as const,
};

const VALID = {
  what: "Rejects unlisted mints before a quote is built.",
  why: "Merchants were charged in tokens they cannot settle.",
  how: "src/pay.ts checks the allowlist ahead of src/quote.ts.",
  proof_refs: [{ kind: "command", label: "unit", value: "pnpm test src/pay.test.ts" }],
  out_of_scope: ["refunds"],
  risks: [{ area: "compat", note: "callers passing unlisted mints now fail", source: "author" }],
};

describe("agent cli selection", () => {
  it("recognises only the two CLI harnesses", () => {
    expect(agentCli("claude")).toBe("claude");
    expect(agentCli("cursor")).toBe("cursor");
    expect(agentCli("codex")).toBeNull();
    expect(agentCli(undefined)).toBeNull();
    expect(agentCli("")).toBeNull();
  });
});

describe("agent prompt", () => {
  const prompt = agentPrompt(INPUT);

  it("ships the house style and the shared output contract", () => {
    expect(prompt).toContain("OUTPUT STYLE, this is not optional");
    expect(prompt).toContain("Never use the em dash character");
    expect(prompt).toContain('"proof_refs"');
    expect(prompt).toContain("Print ONE JSON object and nothing else");
  });

  it("carries the PR, the diff and the retrieved context", () => {
    expect(prompt).toContain(INPUT.title);
    expect(prompt).toContain("src/pay.ts");
    expect(prompt).toContain("unlisted");
    expect(prompt).toContain("domain=PAYMENTS, focus=SECURITY");
    expect(prompt).toContain("Settlement: supported mints");
    expect(prompt).toContain("#12 Add allowlist (linked)");
  });

  it("caps the diff and says so instead of truncating silently", () => {
    const huge = agentPrompt({ ...INPUT, diff: "x".repeat(200_000) });
    expect(huge).toContain("first 120000 of 200000 chars");
    expect(huge.length).toBeLessThan(140_000);
  });
});

describe("understanding extraction", () => {
  it("unwraps the CLI json envelope", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc",
      result: JSON.stringify(VALID),
    });
    expect(extractUnderstanding(stdout)).toEqual(VALID);
  });

  it("survives a fence and a preamble inside the result text", () => {
    const stdout = JSON.stringify({
      result: `Here is the Understanding:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\n`,
    });
    expect(extractUnderstanding(stdout)).toEqual(VALID);
  });

  it("accepts a bare object printed straight to stdout", () => {
    expect(extractUnderstanding(JSON.stringify(VALID))).toEqual(VALID);
    expect(extractUnderstanding(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``)).toEqual(VALID);
  });

  it("returns null on empty or object-free output", () => {
    expect(extractUnderstanding("")).toBeNull();
    expect(extractUnderstanding("   ")).toBeNull();
    expect(extractUnderstanding("I could not analyse this PR.")).toBeNull();
    expect(extractUnderstanding(JSON.stringify({ result: "no json here" }))).toBeNull();
  });
});

describe("agent harness fallback", () => {
  it("keeps producing an Understanding when no CLI harness is selected", async () => {
    const prev = process.env.CYCLOPS_LANE_HARNESS;
    delete process.env.CYCLOPS_LANE_HARNESS;
    try {
      const u = await Effect.runPromise(makeAgentHarness().runUnderstand(INPUT));
      expect(u.what).toContain("unlisted mints");
      expect(u.how).toContain("src/pay.ts");
    } finally {
      if (prev != null) process.env.CYCLOPS_LANE_HARNESS = prev;
    }
  });

  it("falls back to the stub when the selected CLI is not on PATH", async () => {
    const prevHarness = process.env.CYCLOPS_LANE_HARNESS;
    const prevPath = process.env.PATH;
    process.env.CYCLOPS_LANE_HARNESS = "claude";
    process.env.PATH = "/nonexistent-cyclops-test-path";
    try {
      const u = await Effect.runPromise(makeAgentHarness().runUnderstand(INPUT));
      expect(u.what).toContain("unlisted mints");
      expect(u.risks.some((r) => r.area === "harness")).toBe(true);
    } finally {
      process.env.PATH = prevPath;
      if (prevHarness == null) delete process.env.CYCLOPS_LANE_HARNESS;
      else process.env.CYCLOPS_LANE_HARNESS = prevHarness;
    }
  });
});
