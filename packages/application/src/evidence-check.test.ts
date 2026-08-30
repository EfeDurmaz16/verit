import type {
  Claim,
  ClaimProbeEdge,
  Probe,
  ReproductionManifest,
  SideOutcome,
  SideOutcomeState,
  SideRecord,
} from "@verit/domain";
import { describe, expect, it } from "vitest";
import { behaviorProofCheck } from "./check";
import {
  READINESS_LABELS,
  type ProbeRun,
  assembleEvidence,
  readinessLabel,
  renderEvidenceSection,
} from "./evidence-check";

const side = (
  s: "base" | "head",
  state: SideOutcomeState,
  observed: readonly SideOutcomeState[] = [state],
): SideOutcome => ({
  side: s,
  state,
  exitCode: state === "pass" ? 0 : 1,
  runs: observed.length,
  observedStates: [...observed],
  artifactRefs: [],
});

const probe = (id: string): Probe => ({
  id,
  source: "process.exit(0)",
  hash: `hash-${id}`,
  origin: "generated",
  kind: "behavioral",
});

const claim = (id: string, over: Partial<Claim> = {}): Claim => ({
  id,
  statement: `the upload retries once on a transient failure (${id})`,
  state: "source-grounded",
  anchors: [{ kind: "diff", ref: "src/upload.ts", span: "retry once" }],
  modelConfidence: 0.5,
  regions: ["src/upload.ts"],
  ...over,
});

const sides: readonly [SideRecord, SideRecord] = [
  {
    side: "base",
    sha: "aaaaaaaaaaaa",
    selectedToolchain: "node",
    resolvedDependencies: "package.json@abc",
    environmentDigest: "env-base",
  },
  {
    side: "head",
    sha: "bbbbbbbbbbbb",
    selectedToolchain: "node",
    resolvedDependencies: "package.json@abc",
    environmentDigest: "env-head",
  },
];

const manifest: ReproductionManifest = {
  environmentDigest: "env",
  imageDigest: "sha256:image",
  toolchainPins: ["node@22"],
  probeHashes: ["hash-p1"],
  artifactRefs: ["artifact://logs"],
  replayCommand: "verit replay run-1",
};

const run = (over: Partial<ProbeRun> = {}): ProbeRun => ({
  probe: probe("p1"),
  base: side("base", "pass"),
  head: side("head", "fail"),
  probeHeldOutside: true,
  sameProbeHashBothSides: true,
  ...over,
});

const assemble = (over: {
  claims?: readonly Claim[];
  edges?: readonly ClaimProbeEdge[];
  runs?: readonly ProbeRun[];
  jobSpecVerified?: boolean;
  requiredGrade?: "candidate" | "corroborated";
} = {}) =>
  assembleEvidence({
    pullRequest: "EfeDurmaz16/verit#1",
    claims: over.claims ?? [claim("c1")],
    edges: over.edges ?? [{ claimId: "c1", probeId: "p1", role: "primary" }],
    runs: over.runs ?? [run()],
    policy: { orchestration: "two worktrees", isolation: "ephemeral", digest: "policy-1" },
    jobSpec: { specHash: "spec", signature: "sig", probeHashes: ["hash-p1"] },
    jobSpecVerified: over.jobSpecVerified ?? true,
    sides,
    reproduction: manifest,
    ...(over.requiredGrade !== undefined ? { requiredGrade: over.requiredGrade } : {}),
  });

describe("assembling evidence uses only measurements", () => {
  it("classifies a regression and grades a single clean probe as candidate", () => {
    const bundle = assemble();
    expect(bundle.results[0]?.classification).toBe("regression");
    expect(bundle.results[0]?.grade).toBe("candidate");
    expect(bundle.coverage[0]?.status).toBe("contradicted");
  });

  it("refuses a grade when the probe did not survive both sides unchanged", () => {
    const bundle = assemble({ runs: [run({ probeHeldOutside: false })] });
    expect(bundle.results[0]?.classification).toBe("regression");
    expect(bundle.results[0]?.grade).toBeNull();
    expect(bundle.readiness).toBe("inconclusive");
  });

  it("corroborates when an independent result agrees", () => {
    const bundle = assemble({ runs: [run({ corroboratedBy: ["p2"] })] });
    expect(bundle.results[0]?.grade).toBe("corroborated");
  });

  it("keeps a maintainer decision beside the evidence, never inside it", () => {
    const accepted = assemble({ runs: [run({ disposition: "accepted" })] });
    const unreviewed = assemble({ runs: [run({ disposition: "unreviewed" })] });
    expect(accepted.results[0]?.grade).toBe(unreviewed.results[0]?.grade);
    expect(accepted.results[0]?.disposition).toBe("accepted");
  });

  it("asks for corroboration rather than hiding a single-probe regression", () => {
    const bundle = assemble({ requiredGrade: "corroborated" });
    expect(bundle.results[0]?.classification).toBe("regression");
    expect(bundle.readiness).toBe("needs-corroboration");
  });

  it("says needs-claim when nothing could be grounded", () => {
    const bundle = assemble({ claims: [claim("c1", { state: "ambiguous" })] });
    expect(bundle.readiness).toBe("needs-claim");
  });

  it("says needs-evidence when a claim has no probe", () => {
    const bundle = assemble({ edges: [] });
    expect(bundle.readiness).toBe("needs-evidence");
  });

  it("is inconclusive when a side did not hold steady", () => {
    const bundle = assemble({
      runs: [run({ head: side("head", "unstable", ["pass", "fail"]) })],
    });
    expect(bundle.results[0]?.classification).toBe("inconclusive");
    expect(bundle.results[0]?.inconclusiveReason).toContain("unstable");
    expect(bundle.readiness).toBe("inconclusive");
  });
});

describe("evidence never decides whether the pull request may merge", () => {
  const passingProof = {
    command: "pnpm test",
    source: "package.json#scripts.test",
    cwd: "/repo",
    repo: "EfeDurmaz16/verit",
    exitCode: 0,
    durationMs: 10,
    timedOut: false,
    logTail: "ok",
    log: "ok",
    startedAt: new Date(0).toISOString(),
    headSha: "bbbbbbbbbbbb",
    porcelainClean: true,
  };
  const understanding = {
    what: "Adds one retry to the upload path.",
    why: "Uploads failed on transient 503s.",
    how: "Wraps uploadRun in a single retry.",
    proof_refs: [],
    risks: [],
  };

  it("leaves a passing check green while reporting a corroborated regression", () => {
    const bundle = assemble({ runs: [run({ corroboratedBy: ["p2"] })] });
    expect(bundle.results[0]?.classification).toBe("regression");
    expect(bundle.results[0]?.grade).toBe("corroborated");

    const check = behaviorProofCheck({ understanding, outcome: passingProof });
    expect(check.conclusion).toBe("success");

    // the evidence renders into the body and changes nothing about the verdict
    const section = renderEvidenceSection(bundle);
    expect(section).toContain("regression");
    expect(check.conclusion).toBe("success");
  });

  it("says out loud that the conclusion is not its own", () => {
    expect(renderEvidenceSection(assemble())).toContain(
      "conclusion of this check comes from the repository's own tests",
    );
  });

  it("owns exactly one label, drawn from a closed set", () => {
    const bundle = assemble();
    const label = readinessLabel(bundle.readiness);
    expect(READINESS_LABELS).toContain(label);
    expect(READINESS_LABELS).toHaveLength(5);
  });
});

describe("the rendered section is readable and honest", () => {
  it("asks for a sentence when a claim is ambiguous", () => {
    const section = renderEvidenceSection(
      assemble({ claims: [claim("c1", { state: "ambiguous" })] }),
    );
    expect(section).toContain("Restate it in one line");
  });

  it("names the dependency difference as evidence, not as a fault", () => {
    const bundle = assembleEvidence({
      pullRequest: "EfeDurmaz16/verit#1",
      claims: [claim("c1")],
      edges: [{ claimId: "c1", probeId: "p1", role: "primary" }],
      runs: [run()],
      policy: { orchestration: "two worktrees", isolation: "ephemeral", digest: "policy-1" },
      jobSpec: { specHash: "spec", signature: "sig", probeHashes: ["hash-p1"] },
      jobSpecVerified: true,
      sides: [sides[0], { ...sides[1], resolvedDependencies: "package.json@zzz" }],
      reproduction: manifest,
    });
    expect(renderEvidenceSection(bundle)).toContain("part of the evidence, not a fault");
  });

  it("prints the replay command", () => {
    expect(renderEvidenceSection(assemble())).toContain("verit replay run-1");
  });

  it("prints why a result could not be settled", () => {
    const bundle = assemble({
      runs: [run({ head: side("head", "execution-error") })],
    });
    expect(renderEvidenceSection(bundle)).toContain("Why not settled:");
  });
});
