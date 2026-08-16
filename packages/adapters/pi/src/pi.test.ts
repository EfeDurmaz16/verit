import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildDeterministicUnderstanding, makePiHarness } from "./index";

describe("pi adapter", () => {
  it("builds deterministic Understanding from ReviewContext", () => {
    const u = buildDeterministicUnderstanding({
      title: "Add pay gate CLI",
      body: "## Summary\nOperators need gated flows.\n\n## Risks\n- token scope on mint\n",
      paths: ["cli/pay.ts", "gate/service.go"],
      diff: "+ fn pay_gate()\n",
      context: {
        wiki_hits: [{ pageId: "w1", title: "Auth", excerpt: "token rules", score: 1 }],
        pr_graph: [],
        domain: "CRYPTO",
        focus: "SECURITY",
      },
      role: "review",
    });
    expect(u.what).toContain("pay gate");
    expect(u.why.toLowerCase()).toContain("gated");
    expect(u.how).toContain("cli/pay.ts");
    expect(u.risks.some((r) => r.source === "author")).toBe(true);
    expect(u.proof_refs.some((r) => r.label === "changed-path")).toBe(true);
  });

  it("makePiHarness returns valid Understanding without VERIT_PI_BIN", async () => {
    const prev = process.env.VERIT_PI_BIN;
    delete process.env.VERIT_PI_BIN;
    try {
      const harness = makePiHarness();
      const u = await Effect.runPromise(
        harness.runUnderstand({
          title: "t",
          body: "b",
          paths: ["a.ts"],
          diff: "+",
          context: { wiki_hits: [], pr_graph: [], domain: "GENERAL" },
          role: "review",
        }),
      );
      expect(u.what).toBe("t");
      expect(u.how).toContain("a.ts");
    } finally {
      if (prev != null) process.env.VERIT_PI_BIN = prev;
    }
  });
});
