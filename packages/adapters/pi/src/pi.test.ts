import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makePiHarness } from "./index";

describe("pi adapter", () => {
  it("returns null without VERIT_PI_BIN: analysis did not complete", async () => {
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
      expect(u).toBeNull();
    } finally {
      if (prev != null) process.env.VERIT_PI_BIN = prev;
    }
  });
});
