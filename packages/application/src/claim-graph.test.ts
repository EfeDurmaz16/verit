import type { Claim, ClaimCoverage, ClaimProbeEdge, IntegrityGates, ProbeResult } from "@verit/domain";
import { describe, expect, it } from "vitest";
import {
  LARGE_PR_FILES,
  LARGE_PR_LINES,
  buildClaimGraph,
  isLargeChange,
  measureCoverage,
  reviewOrder,
  uncoveredSummary,
} from "./claim-graph";

const gates: IntegrityGates = {
  probeHeldOutside: true,
  sameProbeHashBothSides: true,
  stabilityChecked: true,
  preconditionChecked: true,
  reproductionComplete: true,
  jobSpecVerified: true,
};

const claim = (id: string, regions: readonly string[], over: Partial<Claim> = {}): Claim => ({
  id,
  statement: `claim ${id}`,
  state: "source-grounded",
  anchors: [{ kind: "diff", ref: regions[0] ?? "x", span: "changed" }],
  modelConfidence: 0.5,
  regions: [...regions],
  ...over,
});

const result = (probeId: string, over: Partial<ProbeResult> = {}): ProbeResult => ({
  probeId,
  base: { side: "base", state: "pass", exitCode: 0, runs: 1, observedStates: ["pass"], artifactRefs: [] },
  head: { side: "head", state: "pass", exitCode: 0, runs: 1, observedStates: ["pass"], artifactRefs: [] },
  classification: "no-differential",
  grade: "candidate",
  gates,
  disposition: "unreviewed",
  ...over,
});

const cov = (claimId: string, status: ClaimCoverage["status"]): ClaimCoverage => ({
  claimId,
  status,
  supportingResults: [],
});

describe("the large stratum is decided by size, not by feel", () => {
  it("is ordinary just under both thresholds", () => {
    expect(isLargeChange({ changedFiles: LARGE_PR_FILES, changedLines: LARGE_PR_LINES })).toBe(
      false,
    );
  });
  it("is large past either threshold on its own", () => {
    expect(isLargeChange({ changedFiles: LARGE_PR_FILES + 1, changedLines: 10 })).toBe(true);
    expect(isLargeChange({ changedFiles: 3, changedLines: LARGE_PR_LINES + 1 })).toBe(true);
  });
});

describe("a change is split by what it claims", () => {
  const edges: ClaimProbeEdge[] = [
    { claimId: "c1", probeId: "p1", role: "primary" },
    { claimId: "c2", probeId: "p2", role: "primary" },
  ];

  const graph = buildClaimGraph({
    claims: [claim("c1", ["src/a.ts"]), claim("c2", ["src/b.ts"])],
    edges,
    coverage: [cov("c1", "supported"), cov("c2", "contradicted")],
    changedRegions: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    changedFiles: 4,
    changedLines: 120,
  });

  it("carries one node per claim with its probes and its coverage", () => {
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]?.probeIds).toEqual(["p1"]);
    expect(graph.nodes[1]?.coverage).toBe("contradicted");
  });

  it("names the regions no claim speaks for, rather than counting them away", () => {
    expect(graph.uncoveredRegions).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("says so in the summary line, with the denominator", () => {
    const line = uncoveredSummary(graph);
    expect(line).toContain("2 of 4 changed regions have no claim");
    expect(line).toContain("src/c.ts");
  });

  it("says the opposite plainly when everything is spoken for", () => {
    const full = buildClaimGraph({
      claims: [claim("c1", ["src/a.ts"])],
      edges: [],
      coverage: [cov("c1", "supported")],
      changedRegions: ["src/a.ts"],
      changedFiles: 1,
      changedLines: 10,
    });
    expect(uncoveredSummary(full)).toContain("Every changed region is spoken for");
  });

  it("truncates a long uncovered list without hiding the count", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const big = buildClaimGraph({
      claims: [],
      edges: [],
      coverage: [],
      changedRegions: many,
      changedFiles: 25,
      changedLines: 900,
    });
    const line = uncoveredSummary(big);
    expect(line).toContain("25 of 25");
    expect(line).toContain("and 15 more");
  });
});

describe("review order puts a maintainer where attention is worth most", () => {
  it("leads with a contradicted claim and ends with a supported one", () => {
    const graph = buildClaimGraph({
      claims: [
        claim("c1", ["a"]),
        claim("c2", ["b"]),
        claim("c3", ["c"]),
        claim("c4", ["d"], { state: "ambiguous" }),
      ],
      edges: [],
      coverage: [
        cov("c1", "supported"),
        cov("c2", "contradicted"),
        cov("c3", "inconclusive"),
        cov("c4", "uncovered"),
      ],
      changedRegions: ["a", "b", "c", "d"],
      changedFiles: 4,
      changedLines: 40,
    });
    expect(reviewOrder(graph).map((n) => n.claimId)).toEqual(["c2", "c4", "c3", "c1"]);
  });
});

describe("large changes are measured apart from ordinary ones", () => {
  const build = (changedFiles: number, changedLines: number) =>
    buildClaimGraph({
      claims: [claim("c1", ["a"]), claim("c2", ["b"], { state: "ambiguous" })],
      edges: [{ claimId: "c1", probeId: "p1", role: "primary" }],
      coverage: [cov("c1", "supported"), cov("c2", "uncovered")],
      changedRegions: ["a", "b", "c"],
      changedFiles,
      changedLines,
    });

  it("labels an ordinary change", () => {
    const m = measureCoverage({ graph: build(4, 100), results: [result("p1")] });
    expect(m.stratum).toBe("ordinary");
  });

  it("labels a large change so small ones cannot average it away", () => {
    const m = measureCoverage({
      graph: build(LARGE_PR_FILES + 5, LARGE_PR_LINES + 5),
      results: [result("p1")],
    });
    expect(m.stratum).toBe("large");
  });

  it("reports grounded, probed, conclusive and uncovered separately", () => {
    const m = measureCoverage({
      graph: build(4, 100),
      results: [
        result("p1"),
        result("p2", { classification: "inconclusive", inconclusiveReason: "unstable" }),
      ],
    });
    expect(m).toMatchObject({
      claims: 2,
      claimsGrounded: 1,
      claimsWithProbe: 1,
      claimsConclusive: 1,
      regionsUncovered: 1,
      resultsInconclusive: 1,
      resultsTotal: 2,
    });
  });
});
