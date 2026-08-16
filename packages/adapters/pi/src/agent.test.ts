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

  it("caps a non-diff payload and says so instead of truncating silently", () => {
    // not a unified diff: netting is impossible, the raw slice ships instead
    const huge = agentPrompt({ ...INPUT, diff: "x".repeat(200_000) });
    expect(huge).toContain("first 120000 of 200000 chars");
    expect(huge.length).toBeLessThan(140_000);
  });
});

describe("agent prompt net diff", () => {
  const moved = [
    "export const settle = (o: Order): Receipt => {",
    "  const fee = o.amount * FEE_RATE;",
    "  const total = o.amount + fee;",
    "  return { id: o.id, total, settledAt: clock() };",
    "};",
  ];
  const movePatch = [
    "diff --git a/src/pay.ts b/src/pay.ts",
    "--- a/src/pay.ts",
    "+++ b/src/pay.ts",
    `@@ -10,${moved.length} +10,0 @@`,
    ...moved.map((l) => `-${l}`),
    "diff --git a/src/settle.ts b/src/settle.ts",
    "--- a/src/settle.ts",
    "+++ b/src/settle.ts",
    `@@ -40,0 +40,${moved.length + 2} @@`,
    ...moved.map((l) => `+${l}`),
    "+",
    "+export const NEW_RETRY_LIMIT = 3;",
  ].join("\n");

  it("feeds the net diff with the move summary instead of the raw slice", () => {
    const prompt = agentPrompt({ ...INPUT, diff: movePatch });
    expect(prompt).toContain("MOVE ANALYSIS");
    expect(prompt).toContain("moved without edit");
    expect(prompt).toContain("NET DIFF, moves pre-factored");
    // the genuinely new line is in, the moved body is factored out
    expect(prompt).toContain("NEW_RETRY_LIMIT");
    expect(prompt).not.toContain("settledAt: clock()");
  });

  it("keeps a small parseable diff fully covered: no truncation note", () => {
    const prompt = agentPrompt({ ...INPUT, diff: movePatch });
    expect(prompt).not.toContain("% of the net content");
    expect(prompt).not.toContain("NOT SHOWN");
  });

  it("packs an oversized net diff by risk and lists the rest as unreviewed", () => {
    const bigBody = (name: string, n: number): string[] =>
      Array.from({ length: n }, (_, i) => `export const ${name}${i} = compute("${name}", ${i});`);
    const file = (path: string, lines: string[]): string =>
      [
        `diff --git a/${path} b/${path}`,
        "--- /dev/null",
        `+++ b/${path}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n");
    const patch = [
      file("src/auth/guard.ts", ["export const guard = (s: Session) => s.valid;"]),
      file("src/lib/big-a.ts", bigBody("alpha", 1_800)),
      file("src/lib/big-b.ts", bigBody("bravo", 1_800)),
      file("src/lib/big-c.ts", bigBody("charlie", 1_800)),
    ].join("\n");
    const prompt = agentPrompt({ ...INPUT, diff: patch });
    expect(prompt).toContain("% of the net content");
    expect(prompt).toContain("NOT SHOWN, over budget");
    // the risky one-liner always makes the cut
    expect(prompt).toContain("src/auth/guard.ts");
    expect(prompt.length).toBeLessThan(140_000);
  });

  it("is deterministic: same diff, same prompt", () => {
    expect(agentPrompt({ ...INPUT, diff: movePatch })).toBe(
      agentPrompt({ ...INPUT, diff: movePatch }),
    );
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

describe("agent harness failure", () => {
  it("returns null when no CLI harness is selected and Pi is unset", async () => {
    const prevHarness = process.env.VERIT_LANE_HARNESS;
    const prevPi = process.env.VERIT_PI_BIN;
    delete process.env.VERIT_LANE_HARNESS;
    delete process.env.VERIT_PI_BIN;
    try {
      expect(await Effect.runPromise(makeAgentHarness().runUnderstand(INPUT))).toBeNull();
    } finally {
      if (prevHarness != null) process.env.VERIT_LANE_HARNESS = prevHarness;
      if (prevPi != null) process.env.VERIT_PI_BIN = prevPi;
    }
  });

  it("returns null when the selected CLI is not on PATH: no invented Understanding", async () => {
    const prevHarness = process.env.VERIT_LANE_HARNESS;
    const prevPi = process.env.VERIT_PI_BIN;
    const prevPath = process.env.PATH;
    process.env.VERIT_LANE_HARNESS = "claude";
    delete process.env.VERIT_PI_BIN;
    process.env.PATH = "/nonexistent-verit-test-path";
    try {
      expect(await Effect.runPromise(makeAgentHarness().runUnderstand(INPUT))).toBeNull();
    } finally {
      process.env.PATH = prevPath;
      if (prevHarness == null) delete process.env.VERIT_LANE_HARNESS;
      else process.env.VERIT_LANE_HARNESS = prevHarness;
      if (prevPi != null) process.env.VERIT_PI_BIN = prevPi;
    }
  });
});
