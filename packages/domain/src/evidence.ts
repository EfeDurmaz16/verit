import { Schema as S } from "effect";

/*
 * Differential behavioral evidence.
 *
 * A pull request carries behavioral claims. The same probe, held outside both
 * checkouts, runs on the base commit and on the head commit under one execution
 * policy. What comes back is two side outcomes, and the classification is a
 * pure function of those two outcomes. Nothing a model says enters that
 * function.
 *
 * The three axes stay separate on purpose, because collapsing them is how a
 * review tool starts lying:
 *
 *   classification  what the change did, from the outcomes alone
 *   grade           how independently the result is corroborated
 *   disposition     what a human decided about it
 *
 * A maintainer accepting a finding does not make the finding stronger. A probe
 * written by the repository is not corroborated for being repo-native. Those
 * two rules are enforced by the shape of the functions below: `gradeResult`
 * takes neither provenance nor disposition, so no caller can pass them.
 */

/** An exact span in the material a claim came from. Claims never float free. */
export const SourceAnchor = S.Struct({
  kind: S.Literal("issue", "pr-description", "diff", "repo-context"),
  /** Where the material lives: an issue number, a file path, a hunk header. */
  ref: S.String.pipe(S.minLength(1)),
  /** The quoted span, verbatim from the source. */
  span: S.String.pipe(S.minLength(1)),
});
export type SourceAnchor = S.Schema.Type<typeof SourceAnchor>;

/**
 * Where a claim is in its life.
 *
 * `proposed` is transient: a model wrote it and nothing has grounded it yet.
 * `source-grounded` means every anchor resolves in the material. `ambiguous`
 * means it could not be grounded, which is what asks the author for one
 * sentence. Only the grounded states can carry a run to proof-ready.
 */
export const ClaimState = S.Literal("proposed", "source-grounded", "author-confirmed", "ambiguous");
export type ClaimState = S.Schema.Type<typeof ClaimState>;

export const Claim = S.Struct({
  id: S.String.pipe(S.minLength(1)),
  statement: S.String.pipe(S.minLength(1)),
  state: ClaimState,
  anchors: S.Array(SourceAnchor),
  /**
   * The model's own confidence. It gates one thing only: whether verit asks the
   * author to state the behavior. It is never an input to readiness, so a
   * confident model cannot talk its way to proof-ready.
   */
  modelConfidence: S.Number.pipe(S.between(0, 1)),
  /** Paths or hunk headers this claim covers, verbatim from the diff. */
  regions: S.Array(S.String),
});
export type Claim = S.Schema.Type<typeof Claim>;

/** Who wrote the probe. This is bookkeeping, never a quality signal. */
export const ProbeOrigin = S.Literal("repo-native", "generated", "maintainer-supplied");
export type ProbeOrigin = S.Schema.Type<typeof ProbeOrigin>;

export const Probe = S.Struct({
  id: S.String.pipe(S.minLength(1)),
  /** The probe itself, verbatim. Held outside both checkouts. */
  source: S.String,
  /** sha256 of `source`. The same hash must run on both sides. */
  hash: S.String.pipe(S.minLength(1)),
  origin: ProbeOrigin,
  /**
   * `behavioral` probes answer the claim. `precondition` probes answer a
   * narrower question: was the behavior absent on base at all. Only a
   * precondition probe can establish absence.
   */
  kind: S.Literal("behavioral", "precondition"),
});
export type Probe = S.Schema.Type<typeof Probe>;

/** Claims and probes are many to many. One claim can need several probes. */
export const ClaimProbeEdge = S.Struct({
  claimId: S.String.pipe(S.minLength(1)),
  probeId: S.String.pipe(S.minLength(1)),
  role: S.Literal("primary", "precondition", "supporting"),
});
export type ClaimProbeEdge = S.Schema.Type<typeof ClaimProbeEdge>;

/**
 * What one side of the comparison did.
 *
 * `absent-by-design` is not a failure and not an error: the thing the probe
 * targets does not exist on that side. It is only ever set from a precondition
 * probe, never inferred from a probe that failed to compile.
 * `incompatible` is the probe not applying: a compile error, an API mismatch.
 * `execution-error` is the infrastructure: a timeout, a crashed runner, a
 * failed install. `unstable` is repeats disagreeing.
 */
export const SideOutcomeState = S.Literal(
  "pass",
  "fail",
  "absent-by-design",
  "incompatible",
  "execution-error",
  "unstable",
);
export type SideOutcomeState = S.Schema.Type<typeof SideOutcomeState>;

export const Side = S.Literal("base", "head");
export type Side = S.Schema.Type<typeof Side>;

export const SideOutcome = S.Struct({
  side: Side,
  state: SideOutcomeState,
  exitCode: S.NullOr(S.Number),
  /** How many times the probe ran on this side. */
  runs: S.Number.pipe(S.greaterThanOrEqualTo(1)),
  /** The raw result of each run. Disagreement is what makes a side unstable. */
  observedStates: S.Array(SideOutcomeState),
  artifactRefs: S.Array(S.String),
});
export type SideOutcome = S.Schema.Type<typeof SideOutcome>;

/**
 * The part of the environment that must be identical on both sides. The
 * toolchain is deliberately absent: a pull request may upgrade it, and that
 * difference is evidence, not a reason to refuse.
 */
export const ExecutionPolicy = S.Struct({
  orchestration: S.String.pipe(S.minLength(1)),
  isolation: S.String.pipe(S.minLength(1)),
  digest: S.String.pipe(S.minLength(1)),
});
export type ExecutionPolicy = S.Schema.Type<typeof ExecutionPolicy>;

/** The signed instruction the execution job verifies before it runs anything. */
export const JobSpec = S.Struct({
  specHash: S.String.pipe(S.minLength(1)),
  signature: S.String.pipe(S.minLength(1)),
  probeHashes: S.Array(S.String),
});
export type JobSpec = S.Schema.Type<typeof JobSpec>;

/** What each side actually resolved to. The two may differ, and that is data. */
export const SideRecord = S.Struct({
  side: Side,
  sha: S.String.pipe(S.minLength(1)),
  selectedToolchain: S.String,
  resolvedDependencies: S.String,
  environmentDigest: S.String,
});
export type SideRecord = S.Schema.Type<typeof SideRecord>;

/**
 * What the change did to the behavior, from the two outcomes alone.
 *
 * There is no `capability-missing`. A behavior absent on base whose probe fails
 * on head could be a broken new feature or a probe that does not fit, and the
 * outcomes cannot tell those apart. Saying so is the honest answer.
 */
export const Classification = S.Literal(
  "regression",
  "fix-confirmed",
  "no-differential",
  "unresolved",
  "capability-added",
  "inconclusive",
);
export type Classification = S.Schema.Type<typeof Classification>;

/**
 * How independently a result is supported.
 *
 * `candidate` is a single probe that cleared every integrity gate, whatever
 * wrote it. `corroborated` needs a genuinely independent second probe or a
 * separate trusted behavioral signal agreeing. There is no grade for human
 * approval: a maintainer's opinion is recorded next to the evidence, not
 * folded into it.
 */
export const EvidenceGrade = S.Literal("candidate", "corroborated");
export type EvidenceGrade = S.Schema.Type<typeof EvidenceGrade>;

/** What a human decided. Feeds calibration, never the grade. */
export const MaintainerDisposition = S.Literal("accepted", "rejected", "needs-work", "unreviewed");
export type MaintainerDisposition = S.Schema.Type<typeof MaintainerDisposition>;

/**
 * The mechanical checks a result must clear before it is graded at all. Any
 * false here means the result carries no grade, whatever the outcomes said.
 */
export const IntegrityGates = S.Struct({
  /** The probe never lived inside either checkout. */
  probeHeldOutside: S.Boolean,
  /** The same probe hash ran on base and on head. */
  sameProbeHashBothSides: S.Boolean,
  /** Repeats ran and stability was evaluated. */
  stabilityChecked: S.Boolean,
  /** Absence claims were put to a precondition probe. */
  preconditionChecked: S.Boolean,
  /** The reproduction manifest resolves. */
  reproductionComplete: S.Boolean,
  /** The execution job verified the signed job spec. */
  jobSpecVerified: S.Boolean,
});
export type IntegrityGates = S.Schema.Type<typeof IntegrityGates>;

/** A precondition probe's answer: was the behavior genuinely absent on base. */
export const PreconditionEvidence = S.Struct({
  probeId: S.String.pipe(S.minLength(1)),
  baseAbsenceProven: S.Boolean,
});
export type PreconditionEvidence = S.Schema.Type<typeof PreconditionEvidence>;

export const ProbeResult = S.Struct({
  probeId: S.String.pipe(S.minLength(1)),
  base: SideOutcome,
  head: SideOutcome,
  classification: Classification,
  grade: S.NullOr(EvidenceGrade),
  /** Ids of the independent results that agree. Empty means single-probe. */
  corroboratedBy: S.optional(S.Array(S.String)),
  disposition: MaintainerDisposition,
  /** Required whenever the classification is inconclusive. */
  inconclusiveReason: S.optional(S.String),
});
export type ProbeResult = S.Schema.Type<typeof ProbeResult>;

/**
 * What the evidence says about one claim. `supported` and `contradicted` are
 * deliberately weaker words than proven and refuted: one probe agreeing is not
 * a proof of the claim.
 */
export const CoverageStatus = S.Literal("supported", "contradicted", "uncovered", "inconclusive");
export type CoverageStatus = S.Schema.Type<typeof CoverageStatus>;

export const ClaimCoverage = S.Struct({
  claimId: S.String.pipe(S.minLength(1)),
  status: CoverageStatus,
  supportingResults: S.Array(S.String),
});
export type ClaimCoverage = S.Schema.Type<typeof ClaimCoverage>;

/**
 * Everything a third party needs to run this again and get the same answer. A
 * replay command on its own is not reproducibility: without the environment
 * digest and the artifacts it is a sentence, not a guarantee.
 */
export const ReproductionManifest = S.Struct({
  environmentDigest: S.String.pipe(S.minLength(1)),
  imageDigest: S.String.pipe(S.minLength(1)),
  toolchainPins: S.Array(S.String),
  probeHashes: S.Array(S.String),
  artifactRefs: S.Array(S.String),
  replayCommand: S.String.pipe(S.minLength(1)),
});
export type ReproductionManifest = S.Schema.Type<typeof ReproductionManifest>;

/** What verit is asking the maintainer for. Never an action, only a state. */
export const Readiness = S.Literal(
  "proof-ready",
  "needs-claim",
  "needs-evidence",
  "needs-corroboration",
  "inconclusive",
);
export type Readiness = S.Schema.Type<typeof Readiness>;

export const EvidenceBundle = S.Struct({
  pullRequest: S.String.pipe(S.minLength(1)),
  claims: S.Array(Claim),
  probes: S.Array(Probe),
  edges: S.Array(ClaimProbeEdge),
  policy: ExecutionPolicy,
  jobSpec: JobSpec,
  sides: S.Tuple(SideRecord, SideRecord),
  results: S.Array(ProbeResult),
  coverage: S.Array(ClaimCoverage),
  readiness: Readiness,
  reproduction: ReproductionManifest,
});
export type EvidenceBundle = S.Schema.Type<typeof EvidenceBundle>;

export const decodeEvidenceBundle = S.decodeUnknownEither(EvidenceBundle);
export const encodeEvidenceBundle = S.encodeUnknownEither(EvidenceBundle);

/* -------------------------------------------------------------------------- */
/* Decisions. Pure functions, no model output, no I/O.                         */
/* -------------------------------------------------------------------------- */

/** A side state that means the run told us nothing about the behavior. */
const UNINFORMATIVE: readonly SideOutcomeState[] = ["incompatible", "execution-error", "unstable"];

const uninformative = (o: SideOutcome): string | null =>
  UNINFORMATIVE.includes(o.state) ? `${o.side} ${o.state}` : null;

export interface ClassifiedResult {
  readonly classification: Classification;
  readonly inconclusiveReason?: string;
}

/**
 * The whole of the behavior decision. Two outcomes in, one classification out.
 *
 * Deliberately total: every combination the table below does not name comes
 * back inconclusive with the reason spelled out, because inventing a sixth
 * meaning for an unexpected pair is exactly the dishonesty this product exists
 * to avoid.
 *
 *   pass    -> fail            regression
 *   fail    -> pass            fix-confirmed
 *   pass    -> pass            no-differential
 *   fail    -> fail            unresolved
 *   absent  -> pass            capability-added, precondition required
 *   absent  -> fail            inconclusive, could be broken or ill-fitting
 *   anything uninformative     inconclusive
 */
export const classifyResult = (input: {
  readonly base: SideOutcome;
  readonly head: SideOutcome;
  readonly precondition?: PreconditionEvidence | null;
}): ClassifiedResult => {
  const { base, head, precondition } = input;

  const badBase = uninformative(base);
  const badHead = uninformative(head);
  if (badBase !== null || badHead !== null) {
    const reasons = [badBase, badHead].filter((r): r is string => r !== null);
    return {
      classification: "inconclusive",
      inconclusiveReason: `the run did not tell us about the behavior: ${reasons.join(", ")}`,
    };
  }

  if (base.state === "absent-by-design") {
    if (precondition == null || !precondition.baseAbsenceProven) {
      return {
        classification: "inconclusive",
        inconclusiveReason:
          "the base side reported the behavior absent, but no precondition probe established that absence",
      };
    }
    if (head.state === "pass") return { classification: "capability-added" };
    if (head.state === "fail") {
      return {
        classification: "inconclusive",
        inconclusiveReason:
          "the behavior was absent on base and the probe failed on head. The new behavior may exist and be broken, or the probe may not fit it. The outcomes cannot tell those apart",
      };
    }
    return {
      classification: "inconclusive",
      inconclusiveReason: `the behavior was absent on base and head reported ${head.state}`,
    };
  }

  if (head.state === "absent-by-design") {
    return {
      classification: "inconclusive",
      inconclusiveReason:
        "the head side reported the behavior absent. Absence on head is not a differential result",
    };
  }

  if (base.state === "pass" && head.state === "fail") return { classification: "regression" };
  if (base.state === "fail" && head.state === "pass") return { classification: "fix-confirmed" };
  if (base.state === "pass" && head.state === "pass") return { classification: "no-differential" };
  if (base.state === "fail" && head.state === "fail") return { classification: "unresolved" };

  return {
    classification: "inconclusive",
    inconclusiveReason: `no differential meaning for base ${base.state} and head ${head.state}`,
  };
};

/**
 * Grade a result from its integrity gates and its independent corroboration.
 *
 * The signature is the enforcement. There is no provenance parameter, so a
 * repo-native probe cannot be graded higher for its origin. There is no
 * disposition parameter, so a maintainer accepting a finding cannot raise the
 * grade after the fact.
 */
export const gradeResult = (input: {
  readonly gates: IntegrityGates;
  readonly corroboratedBy: readonly string[];
}): EvidenceGrade | null => {
  const g = input.gates;
  const allGatesPassed =
    g.probeHeldOutside &&
    g.sameProbeHashBothSides &&
    g.stabilityChecked &&
    g.preconditionChecked &&
    g.reproductionComplete &&
    g.jobSpecVerified;
  if (!allGatesPassed) return null;
  return input.corroboratedBy.length > 0 ? "corroborated" : "candidate";
};

/** True when the run disagreed with itself across repeats. */
export const isStable = (o: SideOutcome): boolean =>
  o.observedStates.length > 0 && o.observedStates.every((s) => s === o.observedStates[0]);

/** Classifications that change what a maintainer does about the change. */
export const DECISION_RELEVANT: readonly Classification[] = [
  "regression",
  "fix-confirmed",
  "capability-added",
];

const isDecisionRelevant = (c: Classification): boolean => DECISION_RELEVANT.includes(c);

/** Coverage for one claim, from the results of the probes attached to it. */
export const coverageForClaim = (input: {
  readonly claim: Claim;
  readonly edges: readonly ClaimProbeEdge[];
  readonly results: readonly ProbeResult[];
}): ClaimCoverage => {
  const probeIds = new Set(
    input.edges.filter((e) => e.claimId === input.claim.id).map((e) => e.probeId),
  );
  const mine = input.results.filter((r) => probeIds.has(r.probeId));
  if (mine.length === 0) {
    return { claimId: input.claim.id, status: "uncovered", supportingResults: [] };
  }
  const conclusive = mine.filter((r) => r.classification !== "inconclusive");
  if (conclusive.length === 0) {
    return {
      claimId: input.claim.id,
      status: "inconclusive",
      supportingResults: mine.map((r) => r.probeId),
    };
  }
  // A regression against a claim that the change is safe contradicts it; a
  // fix-confirmed or capability-added supports it. no-differential and
  // unresolved say the claim's behavior did not move, which supports nothing
  // and contradicts nothing, so they leave the claim inconclusive unless a
  // decision-relevant result also landed.
  const contradicting = conclusive.filter((r) => r.classification === "regression");
  if (contradicting.length > 0) {
    return {
      claimId: input.claim.id,
      status: "contradicted",
      supportingResults: contradicting.map((r) => r.probeId),
    };
  }
  const supporting = conclusive.filter(
    (r) => r.classification === "fix-confirmed" || r.classification === "capability-added",
  );
  if (supporting.length > 0) {
    return {
      claimId: input.claim.id,
      status: "supported",
      supportingResults: supporting.map((r) => r.probeId),
    };
  }
  return {
    claimId: input.claim.id,
    status: "inconclusive",
    supportingResults: conclusive.map((r) => r.probeId),
  };
};

const GROUNDED: readonly ClaimState[] = ["source-grounded", "author-confirmed"];

export interface ReadinessInput {
  readonly claims: readonly Claim[];
  readonly coverage: readonly ClaimCoverage[];
  readonly results: readonly ProbeResult[];
  /** Every side of every result held steady across its repeats. */
  readonly outcomesStable: boolean;
  /** The reproduction manifest resolves. */
  readonly reproductionComplete: boolean;
  /** Isolation held and the job spec verified. */
  readonly executionIntegrityClean: boolean;
  /** The maintainer's bar for a decision-relevant result. Defaults to candidate. */
  readonly requiredGrade?: EvidenceGrade;
}

/**
 * What verit asks for next.
 *
 * The model's confidence is not an input here, on purpose: a confident model
 * must not be able to reach proof-ready. Only the grounded claim states, the
 * coverage, the grades and the integrity of the run can.
 */
export const readinessOf = (input: ReadinessInput): Readiness => {
  const requiredGrade = input.requiredGrade ?? "candidate";

  if (input.claims.length === 0) return "needs-claim";
  if (input.claims.some((c) => !GROUNDED.includes(c.state))) return "needs-claim";

  if (input.coverage.some((c) => c.status === "uncovered")) return "needs-evidence";

  if (
    input.coverage.some((c) => c.status === "inconclusive") ||
    !input.outcomesStable ||
    !input.reproductionComplete ||
    !input.executionIntegrityClean
  ) {
    return "inconclusive";
  }

  if (requiredGrade === "corroborated") {
    const weak = input.results.some(
      (r) => isDecisionRelevant(r.classification) && r.grade !== "corroborated",
    );
    if (weak) return "needs-corroboration";
  }

  return "proof-ready";
};

/* -------------------------------------------------------------------------- */
/* Claim grounding. The gate that keeps invented quotes out of the run.        */
/* -------------------------------------------------------------------------- */

/** The material a claim may be drawn from. Whatever is absent cannot ground. */
export interface ClaimSources {
  readonly issue?: string;
  readonly prDescription?: string;
  readonly diff: string;
  readonly repoContext?: string;
}

const sourceText = (kind: SourceAnchor["kind"], sources: ClaimSources): string | undefined => {
  switch (kind) {
    case "issue":
      return sources.issue;
    case "pr-description":
      return sources.prDescription;
    case "diff":
      return sources.diff;
    case "repo-context":
      return sources.repoContext;
  }
};

// ponytail: whitespace-normalized substring match. It tolerates a model
// reflowing a quote while still refusing one it invented. Upgrade to a token
// alignment if reflowing turns out to hide real fabrication.
const normalizeForMatch = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** True when the anchor's span really appears in the material it names. */
export const anchorResolves = (anchor: SourceAnchor, sources: ClaimSources): boolean => {
  const text = sourceText(anchor.kind, sources);
  if (text === undefined || text === "") return false;
  const span = normalizeForMatch(anchor.span);
  if (span === "") return false;
  return normalizeForMatch(text).includes(span);
};

/**
 * Decide a claim's state from its anchors, not from the model's confidence.
 *
 * A claim whose every anchor resolves in the material is source-grounded. A
 * claim with no anchors, or with one that quotes something nobody wrote, is
 * ambiguous, which is what asks the author for a sentence. An author-confirmed
 * claim stays confirmed: a human already said what the change does.
 */
export const groundClaim = (claim: Claim, sources: ClaimSources): Claim => {
  if (claim.state === "author-confirmed") return claim;
  const grounded =
    claim.anchors.length > 0 && claim.anchors.every((a) => anchorResolves(a, sources));
  return { ...claim, state: grounded ? "source-grounded" : "ambiguous" };
};

export const groundClaims = (
  claims: readonly Claim[],
  sources: ClaimSources,
): readonly Claim[] => claims.map((c) => groundClaim(c, sources));
