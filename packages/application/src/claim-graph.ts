import type { Claim, ClaimCoverage, ClaimProbeEdge, ProbeResult } from "@verit/domain";

/*
 * Splitting a large change by what it claims, not by what it touched.
 *
 * A fifty file pull request summarized file by file is fifty summaries and no
 * argument. The same change stated as its behavioral claims is a handful of
 * things a maintainer can accept or reject, and each one either has evidence or
 * visibly does not.
 *
 * The number that matters is not how much was reviewed. It is how much was
 * left out. Regions no claim covers are listed by name, because a large change
 * that looks fully covered is the most expensive lie this tool could tell.
 */

/** The charter's stratum: large changes are measured and reported separately. */
export const LARGE_PR_FILES = 100;
export const LARGE_PR_LINES = 10_000;

export const isLargeChange = (input: {
  readonly changedFiles: number;
  readonly changedLines: number;
}): boolean =>
  input.changedFiles > LARGE_PR_FILES || input.changedLines > LARGE_PR_LINES;

/** One claim with the regions it speaks for and what the evidence said. */
export interface ClaimNode {
  readonly claimId: string;
  readonly statement: string;
  readonly state: Claim["state"];
  readonly regions: readonly string[];
  readonly probeIds: readonly string[];
  readonly coverage: ClaimCoverage["status"];
}

export interface ClaimGraph {
  readonly nodes: readonly ClaimNode[];
  /** Changed regions no claim speaks for. Named, never counted away. */
  readonly uncoveredRegions: readonly string[];
  /** True when this change is measured in the large stratum. */
  readonly large: boolean;
  readonly changedFiles: number;
  readonly changedLines: number;
}

export const buildClaimGraph = (input: {
  readonly claims: readonly Claim[];
  readonly edges: readonly ClaimProbeEdge[];
  readonly coverage: readonly ClaimCoverage[];
  /** Every region the diff touched, so the leftovers can be named. */
  readonly changedRegions: readonly string[];
  readonly changedFiles: number;
  readonly changedLines: number;
}): ClaimGraph => {
  const nodes: ClaimNode[] = input.claims.map((claim) => ({
    claimId: claim.id,
    statement: claim.statement,
    state: claim.state,
    regions: claim.regions,
    probeIds: input.edges.filter((e) => e.claimId === claim.id).map((e) => e.probeId),
    coverage: input.coverage.find((c) => c.claimId === claim.id)?.status ?? "uncovered",
  }));

  const spokenFor = new Set(input.claims.flatMap((c) => c.regions));
  const uncoveredRegions = input.changedRegions.filter((r) => !spokenFor.has(r)).sort();

  return {
    nodes,
    uncoveredRegions,
    large: isLargeChange(input),
    changedFiles: input.changedFiles,
    changedLines: input.changedLines,
  };
};

/**
 * What a run contributes to the pilot measurements.
 *
 * Large changes carry their own thresholds, so a hundred small pull requests
 * cannot average away a fifty thousand line one. Keeping the stratum on the
 * record is what makes the two reportable apart.
 */
export interface CoverageMeasurement {
  readonly stratum: "large" | "ordinary";
  readonly claims: number;
  readonly claimsGrounded: number;
  readonly claimsWithProbe: number;
  readonly claimsConclusive: number;
  readonly regionsChanged: number;
  readonly regionsUncovered: number;
  readonly resultsInconclusive: number;
  readonly resultsTotal: number;
}

const GROUNDED = new Set(["source-grounded", "author-confirmed"]);

export const measureCoverage = (input: {
  readonly graph: ClaimGraph;
  readonly results: readonly ProbeResult[];
}): CoverageMeasurement => {
  const { graph } = input;
  return {
    stratum: graph.large ? "large" : "ordinary",
    claims: graph.nodes.length,
    claimsGrounded: graph.nodes.filter((n) => GROUNDED.has(n.state)).length,
    claimsWithProbe: graph.nodes.filter((n) => n.probeIds.length > 0).length,
    claimsConclusive: graph.nodes.filter(
      (n) => n.coverage === "supported" || n.coverage === "contradicted",
    ).length,
    regionsChanged: graph.changedFiles,
    regionsUncovered: graph.uncoveredRegions.length,
    resultsInconclusive: input.results.filter((r) => r.classification === "inconclusive").length,
    resultsTotal: input.results.length,
  };
};

/**
 * The claim graph as review order: what to read, worst first.
 *
 * A contradicted claim is where a maintainer's attention is worth most, then
 * one nothing measured, then one still waiting on a sentence. Claims whose
 * evidence agrees with them come last, which is the whole point of ordering it.
 */
const RANK: Record<ClaimCoverage["status"], number> = {
  contradicted: 0,
  uncovered: 1,
  inconclusive: 2,
  supported: 3,
};

export const reviewOrder = (graph: ClaimGraph): readonly ClaimNode[] =>
  [...graph.nodes].sort((a, b) => {
    const byCoverage = RANK[a.coverage] - RANK[b.coverage];
    if (byCoverage !== 0) return byCoverage;
    // an ungrounded claim needs a human before an evidenced one does
    const grounded = Number(GROUNDED.has(a.state)) - Number(GROUNDED.has(b.state));
    if (grounded !== 0) return grounded;
    return a.claimId.localeCompare(b.claimId);
  });

/** The line a large change's Check body leads with. Names what was left out. */
export const uncoveredSummary = (graph: ClaimGraph): string => {
  if (graph.uncoveredRegions.length === 0) {
    return `Every changed region is spoken for by a claim (${graph.changedFiles} files).`;
  }
  const shown = graph.uncoveredRegions.slice(0, 10);
  const rest = graph.uncoveredRegions.length - shown.length;
  const tail = rest > 0 ? `, and ${rest} more` : "";
  return `${graph.uncoveredRegions.length} of ${graph.changedFiles} changed regions have no claim, so nothing was measured about them: ${shown.join(", ")}${tail}.`;
};
