import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildReviewContext, runReviewUnderstand } from "@verit/application";
import {
  makeHeuristicClassifier,
  makeMemoryDocumentStore,
  makeMemoryGraphStore,
  makeProofRender,
  makeStubHarness,
} from "./index";

describe("memory adapters + runReviewUnderstand", () => {
  it("writes run + understanding + spec", async () => {
    const docs = makeMemoryDocumentStore();
    const graph = makeMemoryGraphStore();
    await Effect.runPromise(
      graph.upsertRepo({ id: "repo:x", fullName: "o/r" }),
    );
    const context = buildReviewContext({
      pages: [],
      query: "pay",
      edges: [],
      prs: [],
      domain: "GENERAL",
    });
    const result = await Effect.runPromise(
      runReviewUnderstand({
        docs,
        graph,
        harness: makeStubHarness(),
        classifier: makeHeuristicClassifier(),
        render: makeProofRender(),
      })({
        repoId: "repo:x",
        title: "solana pay gate",
        body: "crypto",
        paths: ["cli/pay.ts"],
        diff: "+ fn pay_gate()",
        context,
        presets: {
          reviewer_identity: "normal",
          proof_frequency: "behavior_default",
          codebase_automation: "off",
          inline_comments: "high_conf_only",
          domain: "GENERAL",
        },
        nowIso: new Date().toISOString(),
      }),
    );
    expect(result.understanding.what.length).toBeGreaterThan(0);
    expect(result.skillPackHash).toHaveLength(64);
    const saved = await Effect.runPromise(docs.getUnderstandingJson(result.runId));
    expect(saved?.how.toLowerCase()).toMatch(/diff|path/);
    expect((result.spec as { root: string }).root).toBe("workspace");
  });
});
