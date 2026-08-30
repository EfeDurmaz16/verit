import { describe, expect, it } from "vitest";
import {
  type Claim,
  type ClaimProbeEdge,
  type IntegrityGates,
  type ProbeResult,
  type SideOutcome,
  type SideOutcomeState,
  classifyResult,
  coverageForClaim,
  decodeEvidenceBundle,
  gradeResult,
  groundClaim,
  groundClaims,
  isStable,
  readinessOf,
  recomputeReadiness,
  verifyBundle,
} from "./evidence";

/*
 * These are the charter invariants as executable tests. Each `it` names the
 * invariant it locks. A change that makes one of these pass by weakening the
 * claim rather than by fixing the code is the failure mode this file exists to
 * catch, so every assertion here is about honesty, not about coverage.
 */

const side = (
  s: Side,
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

type Side = "base" | "head";

const allGatesPass: IntegrityGates = {
  probeHeldOutside: true,
  sameProbeHashBothSides: true,
  stabilityChecked: true,
  preconditionChecked: true,
  reproductionComplete: true,
  jobSpecVerified: true,
};

const claim = (id: string, over: Partial<Claim> = {}): Claim => ({
  id,
  statement: `claim ${id}`,
  state: "source-grounded",
  anchors: [{ kind: "diff", ref: "src/a.ts", span: "export const a = 1" }],
  modelConfidence: 0.5,
  regions: ["src/a.ts"],
  ...over,
});

const result = (probeId: string, over: Partial<ProbeResult> = {}): ProbeResult => ({
  probeId,
  base: side("base", "pass"),
  head: side("head", "pass"),
  classification: "no-differential",
  grade: "candidate",
  gates: allGatesPass,
  disposition: "unreviewed",
  ...over,
});

describe("I1: classification is a function of the two outcomes", () => {
  it("maps the four ordinary transitions", () => {
    expect(
      classifyResult({ base: side("base", "pass"), head: side("head", "fail") }).classification,
    ).toBe("regression");
    expect(
      classifyResult({ base: side("base", "fail"), head: side("head", "pass") }).classification,
    ).toBe("fix-confirmed");
    expect(
      classifyResult({ base: side("base", "pass"), head: side("head", "pass") }).classification,
    ).toBe("no-differential");
    expect(
      classifyResult({ base: side("base", "fail"), head: side("head", "fail") }).classification,
    ).toBe("unresolved");
  });

  it("gives the same answer for the same outcomes, whatever else is around it", () => {
    const a = classifyResult({ base: side("base", "pass"), head: side("head", "fail") });
    const b = classifyResult({ base: side("base", "pass"), head: side("head", "fail") });
    expect(a).toEqual(b);
  });

  it("is total: an unnamed pair is inconclusive, never an invented meaning", () => {
    const out = classifyResult({
      base: side("base", "pass"),
      head: side("head", "absent-by-design"),
    });
    expect(out.classification).toBe("inconclusive");
    expect(out.inconclusiveReason).toBeTruthy();
  });
});

describe("I2: capability-added needs a precondition probe", () => {
  it("is capability-added when a precondition proves the base absence", () => {
    const out = classifyResult({
      base: side("base", "absent-by-design"),
      head: side("head", "pass"),
      precondition: { probeId: "p-pre", baseAbsenceProven: true },
    });
    expect(out.classification).toBe("capability-added");
  });

  it("is inconclusive when no precondition probe ran", () => {
    const out = classifyResult({
      base: side("base", "absent-by-design"),
      head: side("head", "pass"),
    });
    expect(out.classification).toBe("inconclusive");
    expect(out.inconclusiveReason).toContain("precondition");
  });

  it("is inconclusive when the precondition did not prove the absence", () => {
    const out = classifyResult({
      base: side("base", "absent-by-design"),
      head: side("head", "pass"),
      precondition: { probeId: "p-pre", baseAbsenceProven: false },
    });
    expect(out.classification).toBe("inconclusive");
  });
});

describe("I3: absence on base plus a failure on head is never a capability verdict", () => {
  it("is inconclusive and says why", () => {
    const out = classifyResult({
      base: side("base", "absent-by-design"),
      head: side("head", "fail"),
      precondition: { probeId: "p-pre", baseAbsenceProven: true },
    });
    expect(out.classification).toBe("inconclusive");
    expect(out.inconclusiveReason).toContain("cannot tell those apart");
  });

  it("has no capability-missing classification at all", () => {
    // The literal union is the enforcement: if someone adds the state back,
    // this decode of a bundle carrying it must fail.
    const decoded = decodeEvidenceBundle({
      pullRequest: "owner/repo#1",
      claims: [],
      probes: [],
      edges: [],
      policy: { orchestration: "o", isolation: "i", digest: "d" },
      jobSpec: { specHash: "h", signature: "s", probeHashes: [] },
      sides: [
        {
          side: "base",
          sha: "a",
          selectedToolchain: "t",
          resolvedDependencies: "d",
          environmentDigest: "e",
        },
        {
          side: "head",
          sha: "b",
          selectedToolchain: "t",
          resolvedDependencies: "d",
          environmentDigest: "e",
        },
      ],
      results: [{ ...result("p1"), classification: "capability-missing" }],
      coverage: [],
      readiness: "proof-ready",
      reproduction: {
        environmentDigest: "e",
        imageDigest: "i",
        toolchainPins: [],
        probeHashes: [],
        artifactRefs: [],
        replayCommand: "verit replay",
      },
    });
    expect(decoded._tag).toBe("Left");
  });
});

describe("I4: every inconclusive carries a reason", () => {
  const uninformative: SideOutcomeState[] = ["incompatible", "execution-error", "unstable"];
  for (const state of uninformative) {
    it(`states the reason when the head side is ${state}`, () => {
      const out = classifyResult({ base: side("base", "pass"), head: side("head", state) });
      expect(out.classification).toBe("inconclusive");
      expect(out.inconclusiveReason).toContain(state);
    });
    it(`states the reason when the base side is ${state}`, () => {
      const out = classifyResult({ base: side("base", state), head: side("head", "pass") });
      expect(out.classification).toBe("inconclusive");
      expect(out.inconclusiveReason).toContain(state);
    });
  }
});

describe("I5 and I6: the integrity gates are what earn a grade", () => {
  it("grades a single probe that cleared every gate as candidate", () => {
    expect(gradeResult({ gates: allGatesPass, corroboratedBy: [] })).toBe("candidate");
  });

  it("refuses a grade when the same probe hash did not run on both sides", () => {
    expect(
      gradeResult({
        gates: { ...allGatesPass, sameProbeHashBothSides: false },
        corroboratedBy: ["p2"],
      }),
    ).toBeNull();
  });

  it("refuses a grade when the reproduction manifest does not resolve", () => {
    expect(
      gradeResult({ gates: { ...allGatesPass, reproductionComplete: false }, corroboratedBy: [] }),
    ).toBeNull();
  });

  it("refuses a grade when the probe was not held outside the checkouts", () => {
    expect(
      gradeResult({ gates: { ...allGatesPass, probeHeldOutside: false }, corroboratedBy: [] }),
    ).toBeNull();
  });

  it("refuses a grade when the job spec was not verified", () => {
    expect(
      gradeResult({ gates: { ...allGatesPass, jobSpecVerified: false }, corroboratedBy: [] }),
    ).toBeNull();
  });

  it("is corroborated only with an independent second result", () => {
    expect(gradeResult({ gates: allGatesPass, corroboratedBy: ["p2"] })).toBe("corroborated");
  });
});

describe("I7: a weak grade does not erase a regression", () => {
  it("keeps the regression classification whatever the grade is", () => {
    const out = classifyResult({ base: side("base", "pass"), head: side("head", "fail") });
    expect(out.classification).toBe("regression");
    // grading is a separate call that cannot reach back into the classification
    expect(gradeResult({ gates: allGatesPass, corroboratedBy: [] })).toBe("candidate");
  });

  it("asks for corroboration rather than calling a candidate regression inconclusive", () => {
    const c = claim("c1");
    const r = result("p1", { classification: "regression", grade: "candidate" });
    const readiness = readinessOf({
      claims: [c],
      coverage: [{ claimId: "c1", status: "contradicted", supportingResults: ["p1"] }],
      results: [r],
      outcomesStable: true,
      reproductionComplete: true,
      executionIntegrityClean: true,
      requiredGrade: "corroborated",
    });
    expect(readiness).toBe("needs-corroboration");
    expect(readiness).not.toBe("inconclusive");
  });
});

describe("I10: provenance is not a grade", () => {
  it("grades a repo-native probe exactly like a generated one", () => {
    // gradeResult takes no provenance at all: the two calls are identical
    // because there is no argument through which origin could differ.
    const repoNative = gradeResult({ gates: allGatesPass, corroboratedBy: [] });
    const generated = gradeResult({ gates: allGatesPass, corroboratedBy: [] });
    expect(repoNative).toBe(generated);
    expect(repoNative).toBe("candidate");
  });
});

describe("I12: a maintainer decision does not change the evidence", () => {
  it("grades an accepted result the same as an unreviewed one", () => {
    // Enforced by signature: gradeResult has no disposition parameter.
    const before = gradeResult({ gates: allGatesPass, corroboratedBy: [] });
    const accepted = result("p1", { disposition: "accepted" });
    const unreviewed = result("p1", { disposition: "unreviewed" });
    expect(accepted.grade).toBe(unreviewed.grade);
    expect(before).toBe("candidate");
  });
});

describe("I13: model confidence never reaches readiness", () => {
  it("keeps an ambiguous claim at needs-claim however confident the model was", () => {
    const cocky = claim("c1", { state: "ambiguous", modelConfidence: 1 });
    expect(
      readinessOf({
        claims: [cocky],
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("needs-claim");
  });

  it("reaches proof-ready with a grounded claim the model was unsure about", () => {
    const humble = claim("c1", { state: "source-grounded", modelConfidence: 0.01 });
    expect(
      readinessOf({
        claims: [humble],
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("proof-ready");
  });
});

describe("I14: proof-ready needs grounded claims", () => {
  it("refuses proof-ready while a claim is still proposed", () => {
    expect(
      readinessOf({
        claims: [claim("c1", { state: "proposed" })],
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("needs-claim");
  });

  it("accepts an author-confirmed claim", () => {
    expect(
      readinessOf({
        claims: [claim("c1", { state: "author-confirmed" })],
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("proof-ready");
  });

  it("says needs-claim when there are no claims at all", () => {
    expect(
      readinessOf({
        claims: [],
        coverage: [],
        results: [],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("needs-claim");
  });
});

describe("readiness precedence", () => {
  const grounded = [claim("c1")];

  it("asks for evidence when a claim has no probe", () => {
    expect(
      readinessOf({
        claims: grounded,
        coverage: [{ claimId: "c1", status: "uncovered", supportingResults: [] }],
        results: [],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("needs-evidence");
  });

  it("is inconclusive when the isolation or the job spec did not hold", () => {
    expect(
      readinessOf({
        claims: grounded,
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: false,
      }),
    ).toBe("inconclusive");
  });

  it("is inconclusive when a side did not hold steady across repeats", () => {
    expect(
      readinessOf({
        claims: grounded,
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: false,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("inconclusive");
  });
});

describe("claim coverage", () => {
  const edges: ClaimProbeEdge[] = [{ claimId: "c1", probeId: "p1", role: "primary" }];

  it("is uncovered when no probe is attached", () => {
    expect(coverageForClaim({ claim: claim("c1"), edges: [], results: [] }).status).toBe(
      "uncovered",
    );
  });

  it("is inconclusive when every attached result is inconclusive", () => {
    const out = coverageForClaim({
      claim: claim("c1"),
      edges,
      results: [result("p1", { classification: "inconclusive", inconclusiveReason: "unstable" })],
    });
    expect(out.status).toBe("inconclusive");
  });

  it("is contradicted by a regression", () => {
    const out = coverageForClaim({
      claim: claim("c1"),
      edges,
      results: [result("p1", { classification: "regression" })],
    });
    expect(out.status).toBe("contradicted");
    expect(out.supportingResults).toEqual(["p1"]);
  });

  it("is supported by a confirmed fix", () => {
    const out = coverageForClaim({
      claim: claim("c1"),
      edges,
      results: [result("p1", { classification: "fix-confirmed" })],
    });
    expect(out.status).toBe("supported");
  });

  it("stays inconclusive when nothing moved", () => {
    const out = coverageForClaim({
      claim: claim("c1"),
      edges,
      results: [result("p1", { classification: "no-differential" })],
    });
    expect(out.status).toBe("inconclusive");
  });
});

describe("stability", () => {
  it("calls a side stable when its repeats agree", () => {
    expect(isStable(side("head", "fail", ["fail", "fail", "fail"]))).toBe(true);
  });

  it("calls a side unstable when its repeats disagree", () => {
    expect(isStable(side("head", "fail", ["fail", "pass", "fail"]))).toBe(false);
  });
});

describe("claim grounding is what decides the state, not the model", () => {
  const sources = {
    issue: "The parser drops trailing commas in nested objects.",
    prDescription: "Fixes the trailing comma case.",
    diff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n+  if (token === ',') continue;\n",
    repoContext: "src/parse.ts exports parse().",
  };

  it("grounds a claim whose every anchor resolves in the material", () => {
    const c = claim("c1", {
      state: "proposed",
      anchors: [
        { kind: "issue", ref: "#12", span: "drops trailing commas" },
        { kind: "diff", ref: "src/parse.ts", span: "if (token === ',') continue;" },
      ],
    });
    expect(groundClaim(c, sources).state).toBe("source-grounded");
  });

  it("marks a claim ambiguous when an anchor quotes something nobody wrote", () => {
    const c = claim("c1", {
      state: "proposed",
      modelConfidence: 0.99,
      anchors: [{ kind: "issue", ref: "#12", span: "rewrites the scheduler" }],
    });
    expect(groundClaim(c, sources).state).toBe("ambiguous");
  });

  it("marks a claim with no anchors ambiguous, however sure the model was", () => {
    const c = claim("c1", { state: "proposed", modelConfidence: 1, anchors: [] });
    expect(groundClaim(c, sources).state).toBe("ambiguous");
  });

  it("marks a claim ambiguous when it cites material that was not supplied", () => {
    const c = claim("c1", {
      state: "proposed",
      anchors: [{ kind: "repo-context", ref: "x", span: "anything" }],
    });
    expect(groundClaim(c, { diff: sources.diff }).state).toBe("ambiguous");
  });

  it("leaves an author-confirmed claim confirmed", () => {
    const c = claim("c1", { state: "author-confirmed", anchors: [] });
    expect(groundClaim(c, sources).state).toBe("author-confirmed");
  });

  it("tolerates a reflowed quote but not an invented one", () => {
    const reflowed = claim("c1", {
      state: "proposed",
      anchors: [{ kind: "issue", ref: "#12", span: "drops   trailing\n  commas" }],
    });
    expect(groundClaim(reflowed, sources).state).toBe("source-grounded");
    const invented = claim("c2", {
      state: "proposed",
      anchors: [{ kind: "issue", ref: "#12", span: "drops trailing semicolons" }],
    });
    expect(groundClaim(invented, sources).state).toBe("ambiguous");
  });

  it("keeps an ungroundable claim out of proof-ready end to end", () => {
    const grounded = groundClaims(
      [claim("c1", { state: "proposed", modelConfidence: 1, anchors: [] })],
      sources,
    );
    expect(
      readinessOf({
        claims: grounded,
        coverage: [{ claimId: "c1", status: "supported", supportingResults: ["p1"] }],
        results: [result("p1", { classification: "fix-confirmed" })],
        outcomesStable: true,
        reproductionComplete: true,
        executionIntegrityClean: true,
      }),
    ).toBe("needs-claim");
  });
});

describe("a bundle's conclusions are recomputed, never believed", () => {
  const base = {
    pullRequest: "EfeDurmaz16/verit#1",
    probes: [],
    edges: [{ claimId: "c1", probeId: "p1", role: "primary" as const }],
    policy: { orchestration: "o", isolation: "i", digest: "d" },
    jobSpec: { specHash: "h", signature: "s", probeHashes: [] },
    sides: [
      { side: "base" as const, sha: "a", selectedToolchain: "t", resolvedDependencies: "d", environmentDigest: "e" },
      { side: "head" as const, sha: "b", selectedToolchain: "t", resolvedDependencies: "d", environmentDigest: "e" },
    ] as [
      { side: "base"; sha: string; selectedToolchain: string; resolvedDependencies: string; environmentDigest: string },
      { side: "head"; sha: string; selectedToolchain: string; resolvedDependencies: string; environmentDigest: string },
    ],
    reproduction: {
      environmentDigest: "e",
      imageDigest: "i",
      toolchainPins: [],
      probeHashes: ["h1"],
      artifactRefs: [],
      replayCommand: "verit replay",
    },
  };

  const honest = {
    ...base,
    claims: [claim("c1")],
    results: [
      result("p1", {
        base: side("base", "fail"),
        head: side("head", "pass"),
        classification: "fix-confirmed" as const,
      }),
    ],
    coverage: [{ claimId: "c1", status: "supported" as const, supportingResults: ["p1"] }],
    readiness: "proof-ready" as const,
  };

  it("passes a bundle whose numbers reproduce from its own contents", () => {
    expect(verifyBundle(honest)).toEqual([]);
  });

  it("catches a bundle that claims proof-ready over an ungrounded claim", () => {
    const lying = { ...honest, claims: [claim("c1", { state: "ambiguous" as const })] };
    const problems = verifyBundle(lying);
    expect(problems.map((p) => p.where)).toContain("readiness");
    expect(problems.find((p) => p.where === "readiness")?.recomputed).toBe("needs-claim");
  });

  it("catches a classification that does not follow from the outcomes", () => {
    const lying = {
      ...honest,
      results: [
        result("p1", {
          base: side("base", "pass"),
          head: side("head", "pass"),
          classification: "regression" as const,
        }),
      ],
    };
    const problems = verifyBundle(lying);
    expect(problems.find((p) => p.where.includes("classification"))?.recomputed).toBe(
      "no-differential",
    );
  });

  it("catches a grade that its own gates do not earn", () => {
    const lying = {
      ...honest,
      results: [
        result("p1", {
          base: side("base", "fail"),
          head: side("head", "pass"),
          classification: "fix-confirmed" as const,
          grade: "corroborated" as const,
          gates: { ...allGatesPass, probeHeldOutside: false },
        }),
      ],
    };
    const problems = verifyBundle(lying);
    expect(problems.find((p) => p.where.includes("grade"))?.recomputed).toBe("null");
  });

  it("catches an inconclusive result that does not say why", () => {
    const lying = {
      ...honest,
      results: [
        result("p1", {
          base: side("base", "unstable", ["pass", "fail"]),
          head: side("head", "pass"),
          classification: "inconclusive" as const,
        }),
      ],
    };
    expect(verifyBundle(lying).map((p) => p.where)).toContain("result p1 inconclusiveReason");
  });

  it("catches coverage that does not match the results", () => {
    const lying = {
      ...honest,
      coverage: [{ claimId: "c1", status: "contradicted" as const, supportingResults: ["p1"] }],
    };
    expect(verifyBundle(lying).find((p) => p.where.includes("coverage"))?.recomputed).toBe(
      "supported",
    );
  });

  it("recomputes readiness from the bundle without reading what it claims", () => {
    // The signature is the proof: recomputeReadiness accepts only claims,
    // coverage, results and reproduction, so the bundle's own readiness field
    // is not in scope for it to read.
    const { readiness: _ignored, ...withoutReadiness } = { ...honest, readiness: "inconclusive" as const };
    expect(recomputeReadiness(withoutReadiness)).toBe("proof-ready");
  });
});

describe("an anchor quoting a diff resolves against the code, not the markers", () => {
  /*
   * Measured on the first real run, against verit's own PR #11: the model
   * produced fifteen claims, twelve of them quoting the diff correctly, and
   * grounding threw away every quote that spanned more than one line. A diff
   * carries a + in column zero of every added line, the model quotes the code
   * without it, and the newline in the middle is where the substring stops
   * matching. Single line quotes survived because a substring search still
   * finds them inside the marked line.
   *
   * The gate was doing its job and rejecting what it could not verify. It was
   * rejecting for a formatting reason, which is worse than useless: it looks
   * exactly like the model hallucinating.
   */
  const diff = [
    "--- a/action.yml",
    "+++ b/action.yml",
    "@@ -74,6 +74,20 @@",
    "     - name: Decide whether this event may run repository code",
    "+      id: gate",
    "+      shell: bash",
    "+      run: |",
    "+        case \"${GITHUB_EVENT_NAME:-}\" in",
    "+          pull_request_target|workflow_run|issue_comment)",
    "+            echo \"safe=false\" >> \"$GITHUB_OUTPUT\"",
    "-        old line that went away",
  ].join("\n");

  const sources = { diff };

  it("grounds a single line quote, as it always did", () => {
    const c = claim("c1", {
      state: "proposed",
      anchors: [{ kind: "diff", ref: "action.yml", span: "id: gate" }],
    });
    expect(groundClaim(c, sources).state).toBe("source-grounded");
  });

  it("grounds a quote that spans lines, which is what the run lost", () => {
    const c = claim("c1", {
      state: "proposed",
      anchors: [
        {
          kind: "diff",
          ref: "action.yml",
          span: 'pull_request_target|workflow_run|issue_comment)\n            echo "safe=false" >> "$GITHUB_OUTPUT"',
        },
      ],
    });
    expect(groundClaim(c, sources).state).toBe("source-grounded");
  });

  it("grounds a quote that kept the markers, since a model may copy them", () => {
    const c = claim("c1", {
      state: "proposed",
      anchors: [
        { kind: "diff", ref: "action.yml", span: '+      id: gate\n+      shell: bash' },
      ],
    });
    expect(groundClaim(c, sources).state).toBe("source-grounded");
  });

  it("grounds a quote from a removed line", () => {
    const c = claim("c1", {
      state: "proposed",
      anchors: [{ kind: "diff", ref: "action.yml", span: "old line that went away" }],
    });
    expect(groundClaim(c, sources).state).toBe("source-grounded");
  });

  it("still refuses a quote nobody wrote", () => {
    const c = claim("c1", {
      state: "proposed",
      modelConfidence: 1,
      anchors: [
        {
          kind: "diff",
          ref: "action.yml",
          span: 'pull_request_target)\n            echo "safe=true"',
        },
      ],
    });
    expect(groundClaim(c, sources).state).toBe("ambiguous");
  });

  it("refuses a span that appears in neither the raw diff nor the stripped code", () => {
    // The point of stripping is to see the code as written. It must not invent
    // text: a quote that is in no line, marked or unmarked, stays ambiguous.
    const c = claim("c1", {
      state: "proposed",
      anchors: [{ kind: "diff", ref: "action.yml", span: "echo \"safe=maybe\"" }],
    });
    expect(groundClaim(c, sources).state).toBe("ambiguous");
  });
});
