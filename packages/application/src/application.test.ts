import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { behaviorProofCheck } from "./check";
import { compileReviewPack } from "./compiler";
import { buildWikiHits, buildReviewContext } from "./context";
import { inferEmbeddingSimilarEdges, inferSameAuthorPathEdges } from "./edges";
import { markdownToWikiPages } from "./ingest-wiki";
import { understandingToProofSpec } from "./proof-spec";
import { decodeUnderstanding, type ReviewPresets } from "@verit/domain";

const basePresets: ReviewPresets = {
  reviewer_identity: "harsh",
  proof_frequency: "behavior_default",
  codebase_automation: "off",
  inline_comments: "high_conf_only",
  domain: "CRYPTO",
  focus: "SECURITY",
};

describe("compileReviewPack", () => {
  it("is deterministic and includes verbs", () => {
    const a = compileReviewPack(basePresets);
    const b = compileReviewPack(basePresets);
    expect(a.skillPackHash).toBe(b.skillPackHash);
    expect(a.skillsToml).toContain('id = "understand"');
    expect(a.skillsToml).toContain('id = "prove"');
    expect(a.skillsToml).toContain('id = "post"');
    expect(a.append).toContain("domain=CRYPTO");
  });
});

describe("wiki + context", () => {
  it("splits markdown and searches", () => {
    const pages = markdownToWikiPages(
      "repo:1",
      "AGENTS.md",
      "# Pay\n\nGate flows\n\n## Auth\n\nToken rules\n",
    );
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const hits = buildWikiHits(pages, "token");
    expect(hits[0]?.excerpt.toLowerCase()).toContain("token");
  });
});

describe("inferred edges", () => {
  it("same author path within 14d", () => {
    const cur = {
      id: "pr:1",
      repoId: "r",
      number: 1,
      title: "a",
      author: "efe",
      baseRef: "main",
      headRef: "f",
      url: "u",
      changedPaths: ["cli/pay.ts"],
      updatedAt: "2026-07-20T00:00:00Z",
    };
    const other = {
      ...cur,
      id: "pr:2",
      number: 2,
      changedPaths: ["cli/gate.ts"],
      updatedAt: "2026-07-25T00:00:00Z",
    };
    const edges = inferSameAuthorPathEdges(cur, [other]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.inferred).toBe(true);
  });

  it("embedding similar", () => {
    const a = {
      id: "pr:1",
      repoId: "r",
      number: 1,
      title: "pay gate cli",
      body: "add pay gate",
      author: "x",
      baseRef: "main",
      headRef: "f",
      url: "u",
    };
    const b = { ...a, id: "pr:2", number: 2, title: "pay gate cli commands", body: "add pay gate" };
    const edges = inferEmbeddingSimilarEdges(a, [b], 0.5);
    expect(edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe("proof spec", () => {
  it("builds workspace root", () => {
    const spec = understandingToProofSpec({
      understanding: {
        what: "w",
        why: "y",
        how: "h",
        proof_refs: [],
        risks: [{ area: "x", note: "n", source: "author" }],
      },
      domain: "CRYPTO",
    });
    expect((spec as { root: string }).root).toBe("workspace");
    const els = (spec as { elements: Record<string, { type: string }> }).elements;
    expect(els.summary?.type).toBe("Understanding");
    expect(els.archGraph?.type).toBe("ArchGraph");
  });
});

describe("buildReviewContext", () => {
  it("assembles", () => {
    const ctx = buildReviewContext({
      pages: [],
      query: "",
      edges: [],
      prs: [],
      domain: "GENERAL",
    });
    expect(ctx.wiki_hits).toEqual([]);
  });
});

describe("behaviorProofCheck output style", () => {
  /* Prose written by the model. Every field carries an em dash on purpose. */
  const dirty = decodeUnderstanding({
    what: "Adds a retry — the client now retries once on 429.",
    why: "Rate limits broke checkout — orders were dropped.",
    how: "src/pay.ts wraps fetch — see retryOnce().",
    proof_refs: [
      { kind: "test", label: "retry test — proves the backoff", value: "pnpm test pay" },
    ],
    out_of_scope: ["Idempotency keys — left for a later PR"],
    risks: [{ area: "retry", note: "A retry can double charge — no idempotency key yet.", source: "reviewer" }],
  });

  const outcome = {
    command: "pnpm run test",
    source: "package.json",
    cwd: "/tmp/r",
    repo: "acme/pay",
    exitCode: 1,
    durationMs: 4200,
    timedOut: false,
    logTail: "1 failed\n",
    log: "running 2 tests\n1 failed\n",
    startedAt: "2026-08-09T00:00:00Z",
  };

  it("normalizes the model's em dashes away when decoding", () => {
    expect(Either.isRight(dirty)).toBe(true);
    if (Either.isLeft(dirty)) return;
    expect(dirty.right.what).toBe("Adds a retry, the client now retries once on 429.");
  });

  it("renders a Check body with no em dash", () => {
    if (Either.isLeft(dirty)) throw new Error("fixture failed to decode");
    for (const o of [null, outcome]) {
      const check = behaviorProofCheck({ understanding: dirty.right, outcome: o });
      expect(check.summary).not.toContain("—");
      expect(check.title).not.toContain("—");
    }
  });
});

describe("behaviorProofCheck without an Understanding", () => {
  const passing = {
    command: "pnpm run test",
    source: "package.json#scripts.test",
    cwd: "/tmp/r",
    repo: "acme/pay",
    exitCode: 0,
    durationMs: 900,
    timedOut: false,
    logTail: "12 passed\n",
    log: "running 12 tests\n12 passed\n",
    startedAt: "2026-08-09T00:00:00Z",
  };

  it("lane fails + tests pass: conclusion is neutral, never success", () => {
    const check = behaviorProofCheck({ understanding: null, outcome: passing });
    expect(check.conclusion).toBe("neutral");
    expect(check.title).toContain("Analysis did not complete");
    // the prove result still reports its own pass inside the neutral body
    expect(check.summary).toContain("Analysis did not complete");
    expect(check.summary).toContain("exited **0**");
  });

  it("lane fails + tests fail: still neutral, with the failure in the body", () => {
    const check = behaviorProofCheck({
      understanding: null,
      outcome: { ...passing, exitCode: 1, logTail: "1 failed\n" },
    });
    expect(check.conclusion).toBe("neutral");
    expect(check.summary).toContain("exited **1**");
  });

  it("lane fails + no proof: neutral and says nothing ran", () => {
    const check = behaviorProofCheck({ understanding: null, outcome: null });
    expect(check.conclusion).toBe("neutral");
    expect(check.summary).toContain("Nothing was run to check this change");
  });
});
