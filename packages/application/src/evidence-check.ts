import {
  type Claim,
  type ClaimProbeEdge,
  type ClaimCoverage,
  type EvidenceBundle,
  type EvidenceGrade,
  type ExecutionPolicy,
  type JobSpec,
  type MaintainerDisposition,
  type PreconditionEvidence,
  type Probe,
  type ProbeResult,
  type Readiness,
  type ReproductionManifest,
  type SideOutcome,
  type SideRecord,
  classifyResult,
  coverageForClaim,
  gradeResult,
  isStable,
  readinessOf,
} from "@verit/domain";

/*
 * Where the pieces meet.
 *
 * Everything above this file is a pure decision or a measured run. This is the
 * one place that puts them together into what a maintainer sees, and the one
 * rule it must never break is that none of it can change the Check conclusion.
 * A corroborated regression is a label and a paragraph. Whether the pull
 * request may merge stays with the repository's own tests and the maintainer's
 * own branch protection, because a review tool that can block on its own
 * judgement will eventually block on a wrong one.
 */

/** One probe, run on both sides, with everything needed to grade it. */
export interface ProbeRun {
  readonly probe: Probe;
  readonly base: SideOutcome;
  readonly head: SideOutcome;
  /** The probe's bytes were unchanged after both sides ran. */
  readonly probeHeldOutside: boolean;
  /** The same probe hash ran on base and on head. */
  readonly sameProbeHashBothSides: boolean;
  /** Set when a precondition probe spoke to the base absence. */
  readonly precondition?: PreconditionEvidence | null;
  /** Independent results agreeing with this one. */
  readonly corroboratedBy?: readonly string[];
  readonly disposition?: MaintainerDisposition;
}

export interface AssembleInput {
  readonly pullRequest: string;
  readonly claims: readonly Claim[];
  readonly edges: readonly ClaimProbeEdge[];
  readonly runs: readonly ProbeRun[];
  readonly policy: ExecutionPolicy;
  readonly jobSpec: JobSpec;
  /** True when the execution job verified the signed spec before running. */
  readonly jobSpecVerified: boolean;
  readonly sides: readonly [SideRecord, SideRecord];
  readonly reproduction: ReproductionManifest;
  /** The maintainer's bar for a decision-relevant result. */
  readonly requiredGrade?: EvidenceGrade;
}

/** A manifest resolves when it names an environment, an image and a probe. */
export const reproductionResolves = (m: ReproductionManifest): boolean =>
  m.environmentDigest !== "" &&
  m.imageDigest !== "" &&
  m.probeHashes.length > 0 &&
  m.replayCommand !== "";

const resultFor = (run: ProbeRun, reproductionComplete: boolean, jobSpecVerified: boolean): ProbeResult => {
  const classified = classifyResult({
    base: run.base,
    head: run.head,
    precondition: run.precondition ?? null,
  });
  const corroboratedBy = run.corroboratedBy ?? [];
  const gates = {
    probeHeldOutside: run.probeHeldOutside,
    sameProbeHashBothSides: run.sameProbeHashBothSides,
    stabilityChecked: isStable(run.base) && isStable(run.head),
    preconditionChecked:
      run.base.state !== "absent-by-design" || (run.precondition?.baseAbsenceProven ?? false),
    reproductionComplete,
    jobSpecVerified,
  };
  const grade = gradeResult({ gates, corroboratedBy });
  return {
    probeId: run.probe.id,
    base: run.base,
    head: run.head,
    classification: classified.classification,
    grade,
    gates,
    ...(corroboratedBy.length > 0 ? { corroboratedBy } : {}),
    disposition: run.disposition ?? "unreviewed",
    ...(classified.inconclusiveReason !== undefined
      ? { inconclusiveReason: classified.inconclusiveReason }
      : {}),
  };
};

/**
 * Build the bundle a maintainer reads and a router could consume.
 *
 * Every field here comes from a measurement or from a pure function over
 * measurements. The model's part of the work ended when it proposed the claims
 * and the probes; nothing it said reaches the classification, the grade or the
 * readiness.
 */
export const assembleEvidence = (input: AssembleInput): EvidenceBundle => {
  const reproductionComplete = reproductionResolves(input.reproduction);
  const results = input.runs.map((r) =>
    resultFor(r, reproductionComplete, input.jobSpecVerified),
  );
  const coverage: ClaimCoverage[] = input.claims.map((claim) =>
    coverageForClaim({ claim, edges: input.edges, results }),
  );
  const outcomesStable = input.runs.every((r) => isStable(r.base) && isStable(r.head));
  const executionIntegrityClean =
    input.jobSpecVerified &&
    input.runs.every((r) => r.probeHeldOutside && r.sameProbeHashBothSides);
  const readiness = readinessOf({
    claims: input.claims,
    coverage,
    results,
    outcomesStable,
    reproductionComplete,
    executionIntegrityClean,
    ...(input.requiredGrade !== undefined ? { requiredGrade: input.requiredGrade } : {}),
  });
  return {
    pullRequest: input.pullRequest,
    claims: input.claims,
    probes: input.runs.map((r) => r.probe),
    edges: input.edges,
    policy: input.policy,
    jobSpec: input.jobSpec,
    sides: input.sides,
    results,
    coverage,
    readiness,
    reproduction: input.reproduction,
  };
};

/* --------------------------------- surface --------------------------------- */

/** The one label verit manages on a pull request. It replaces its predecessor,
    it never accumulates, and it never closes or rejects anything. */
export const readinessLabel = (readiness: Readiness): string => `verit:${readiness}`;

/** Every label verit may own, so a caller can remove the stale one in place. */
export const READINESS_LABELS: readonly string[] = [
  "proof-ready",
  "needs-claim",
  "needs-evidence",
  "needs-corroboration",
  "inconclusive",
].map((r) => `verit:${r}`);

const CLASSIFICATION_LABEL: Record<string, string> = {
  regression: "the behavior passed on base and fails on head",
  "fix-confirmed": "the behavior failed on base and passes on head",
  "no-differential": "the behavior did not move",
  unresolved: "the behavior failed on both sides",
  "capability-added": "the behavior was absent on base and passes on head",
  inconclusive: "no differential result",
};

const READINESS_LINE: Record<Readiness, string> = {
  "proof-ready": "Every claim is grounded and covered. This is ready for a human decision.",
  "needs-claim":
    "No grounded claim yet. Say in one line what this change should do differently, and verit will try to prove it.",
  "needs-evidence": "A claim here has no probe yet, so nothing has been measured about it.",
  "needs-corroboration":
    "A result that would change your decision rests on a single probe. A second, independent probe would settle it.",
  inconclusive: "The runs did not settle the behavior. The reasons are listed per probe.",
};

/**
 * The evidence section of the Check body.
 *
 * It states what ran, what the two sides did, and what could not be settled.
 * There is no score and no verdict on the pull request itself: the reader
 * decides, and this text exists to make that decision cheaper.
 */
export const renderEvidenceSection = (bundle: EvidenceBundle): string => {
  const lines: string[] = ["## Behavioral evidence", "", READINESS_LINE[bundle.readiness], ""];

  if (bundle.claims.length === 0) {
    lines.push("No behavioral claim could be grounded in the issue, the description or the diff.");
    return lines.join("\n");
  }

  const [base, head] = bundle.sides;
  lines.push(`Base \`${base.sha.slice(0, 8)}\` against head \`${head.sha.slice(0, 8)}\`.`);
  if (base.resolvedDependencies !== head.resolvedDependencies) {
    lines.push("The two sides resolved different dependencies. That difference is part of the evidence, not a fault.");
  }
  lines.push("");

  for (const claim of bundle.claims) {
    const cov = bundle.coverage.find((c) => c.claimId === claim.id);
    lines.push(`### ${claim.statement}`);
    lines.push("");
    if (claim.state === "ambiguous") {
      lines.push("This claim could not be grounded in anything you wrote. Restate it in one line.");
      lines.push("");
      continue;
    }
    lines.push(`Coverage: ${cov?.status ?? "uncovered"}.`);
    const mine = new Set(
      bundle.edges.filter((e) => e.claimId === claim.id).map((e) => e.probeId),
    );
    for (const r of bundle.results.filter((x) => mine.has(x.probeId))) {
      const what = CLASSIFICATION_LABEL[r.classification] ?? r.classification;
      const grade = r.grade === null ? "not graded" : r.grade;
      lines.push(`- \`${r.probeId}\`: ${r.classification}, ${what}. Evidence ${grade}.`);
      if (r.inconclusiveReason !== undefined) {
        lines.push(`  Why not settled: ${r.inconclusiveReason}`);
      }
    }
    lines.push("");
  }

  lines.push("Replay any of this yourself:");
  lines.push("");
  lines.push("```");
  lines.push(bundle.reproduction.replayCommand);
  lines.push("```");
  lines.push("");
  lines.push(
    "The conclusion of this check comes from the repository's own tests, not from the evidence above.",
  );
  return lines.join("\n");
};
