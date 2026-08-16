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
    expect(result.understanding?.what.length).toBeGreaterThan(0);
    expect(result.skillPackHash).toHaveLength(64);
    const saved = await Effect.runPromise(docs.getUnderstandingJson(result.runId));
    expect(saved?.how.toLowerCase()).toMatch(/diff|path/);
    expect((result.spec as { root: string }).root).toBe("workspace");
  });

  it("stamps a coverage risk on the Understanding when the diff exceeds the budget", async () => {
    const docs = makeMemoryDocumentStore();
    const graph = makeMemoryGraphStore();
    const context = buildReviewContext({
      pages: [],
      query: "big",
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
        title: "huge refactor",
        body: "",
        paths: ["a.ts"],
        diff: "x".repeat(200_000),
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
    // a non-diff payload cannot be netted, so net chars fall back to gross:
    // 120000 of 200000 is still 60%
    const coverage = result.understanding?.risks.find((r) => r.area === "coverage");
    expect(coverage?.note).toContain("Reviewed 60% of the net diff");
    expect(result.netDiffChars).toBe(200_000);
  });

  it("stamps no coverage risk when a huge diff is mostly moved code", async () => {
    // gross far beyond the budget, but the change is one giant file move:
    // the net diff is empty, so the lane saw all of it and coverage is 100
    const body = Array.from(
      { length: 1_500 },
      (_, i) => `export const row${i} = compute("row", ${i}, ${i * 7});`,
    );
    const diff = [
      "diff --git a/src/table.ts b/src/table.ts",
      "--- a/src/table.ts",
      "+++ /dev/null",
      `@@ -1,${body.length} +0,0 @@`,
      ...body.map((l) => `-${l}`),
      "diff --git a/src/data/table.ts b/src/data/table.ts",
      "--- /dev/null",
      "+++ b/src/data/table.ts",
      `@@ -0,0 +1,${body.length} @@`,
      ...body.map((l) => `+${l}`),
    ].join("\n");
    expect(diff.length).toBeGreaterThan(120_000);
    const docs = makeMemoryDocumentStore();
    const graph = makeMemoryGraphStore();
    const context = buildReviewContext({
      pages: [],
      query: "move",
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
        title: "move the table",
        body: "",
        paths: ["src/data/table.ts"],
        diff,
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
    expect(result.netDiffChars).toBe(0);
    const coverage = result.understanding?.risks.find((r) => r.area === "coverage");
    expect(coverage).toBeUndefined();
  });
});
