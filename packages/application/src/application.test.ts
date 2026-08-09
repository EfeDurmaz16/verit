import { describe, expect, it } from "vitest";
import { compileReviewPack } from "./compiler";
import { buildWikiHits, buildReviewContext } from "./context";
import { inferEmbeddingSimilarEdges, inferSameAuthorPathEdges } from "./edges";
import { markdownToWikiPages } from "./ingest-wiki";
import { understandingToProofSpec } from "./proof-spec";
import type { ReviewPresets } from "@cyclops/domain";

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
