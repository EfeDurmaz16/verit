import { describe, expect, it } from "vitest";
import {
  DecisionRecord,
  ExecutionMemoryRecord,
  OutcomeRecord,
  corpusConsent,
  decodeDecisionRecord,
  decodeExecutionMemory,
  decodeOutcomeRecord,
  isForbiddenCorpusKey,
  normalizeDecision,
  normalizeExecutionMemory,
  normalizeOutcome,
} from "./corpus";

/*
 * The privacy contract, as tests.
 *
 * The corpus is reused across repositories, which is what makes it worth
 * having and exactly why it must not hold anyone's code, logs or artifacts.
 * These tests hold the record shapes to that promise, so a field added later
 * that would carry content across a customer boundary fails here rather than
 * shipping.
 */

const AT = "2026-08-30T00:00:00.000Z";

describe("no corpus record has a field that could carry content", () => {
  const shapes = {
    ExecutionMemoryRecord,
    OutcomeRecord,
    DecisionRecord,
  };
  for (const [name, schema] of Object.entries(shapes)) {
    it(`${name} carries only facts about a run`, () => {
      const fields = Object.keys(schema.fields);
      const offenders = fields.filter(isForbiddenCorpusKey);
      expect(offenders).toEqual([]);
    });
  }

  it("knows which key names are content", () => {
    for (const key of ["source", "logTail", "stdout", "artifactRefs", "diff", "authorEmail", "filePath"]) {
      expect(isForbiddenCorpusKey(key)).toBe(true);
    }
    for (const key of ["repoId", "probeHash", "classification", "stable", "runsPerSide"]) {
      expect(isForbiddenCorpusKey(key)).toBe(false);
    }
  });
});

describe("normalization is the only door in", () => {
  it("copies an allowlist and drops everything else it was handed", () => {
    const record = normalizeExecutionMemory({
      repoId: "repo-1",
      toolchainDigest: "tc",
      dependencyDigest: "dep",
      installCommand: "pnpm install --frozen-lockfile",
      installOutcome: "ok",
      installMillis: 1234.6,
      policyDigest: "policy",
      observedAt: AT,
      // a caller spreading a whole run object at it
      ...({ log: "secret token abc123", source: "console.log(process.env)" } as object),
    });
    expect(Object.keys(record).sort()).toEqual([
      "dependencyDigest",
      "installCommand",
      "installMillis",
      "installOutcome",
      "observedAt",
      "policyDigest",
      "repoId",
      "toolchainDigest",
    ]);
    expect(JSON.stringify(record)).not.toContain("abc123");
    expect(record.installMillis).toBe(1235);
  });

  it("keeps the outcome record to states and counts", () => {
    const record = normalizeOutcome({
      repoId: "repo-1",
      probeHash: "h1",
      probeOrigin: "generated",
      baseState: "pass",
      headState: "fail",
      classification: "regression",
      grade: "candidate",
      runsPerSide: 2,
      stable: true,
      observedAt: AT,
      ...({ logTail: "Error: password=hunter2" } as object),
    });
    expect(JSON.stringify(record)).not.toContain("hunter2");
    expect(decodeOutcomeRecord(record)._tag).toBe("Right");
  });

  it("keeps the decision record to what a human chose", () => {
    const record = normalizeDecision({
      repoId: "repo-1",
      probeHash: "h1",
      classification: "regression",
      grade: "corroborated",
      disposition: "accepted",
      readiness: "proof-ready",
      observedAt: AT,
      ...({ note: "the maintainer said something private" } as object),
    });
    expect(JSON.stringify(record)).not.toContain("private");
    expect(decodeDecisionRecord(record)._tag).toBe("Right");
  });

  it("produces records that decode against their own schema", () => {
    expect(
      decodeExecutionMemory(normalizeExecutionMemory({ repoId: "r", observedAt: AT }))._tag,
    ).toBe("Right");
  });

  it("never stores a negative duration or a zero run count", () => {
    const mem = normalizeExecutionMemory({ repoId: "r", installMillis: -5, observedAt: AT });
    expect(mem.installMillis).toBe(0);
    const out = normalizeOutcome({
      repoId: "r",
      probeHash: "h",
      probeOrigin: "repo-native",
      baseState: "pass",
      headState: "pass",
      classification: "no-differential",
      runsPerSide: 0,
      observedAt: AT,
    });
    expect(out.runsPerSide).toBe(1);
  });
});

describe("consent decides whether anything is remembered", () => {
  it("remembers a public repository by default", () => {
    expect(corpusConsent({ visibility: "public" })).toBe(true);
  });

  it("stops for a public repository that opted out", () => {
    expect(corpusConsent({ visibility: "public", optOut: true })).toBe(false);
  });

  it("does not remember a private repository until someone opts in", () => {
    expect(corpusConsent({ visibility: "private" })).toBe(false);
    expect(corpusConsent({ visibility: "private", optIn: true })).toBe(true);
  });

  it("lets an opt out win over an opt in", () => {
    expect(corpusConsent({ visibility: "private", optIn: true, optOut: true })).toBe(false);
  });

  it("treats an unknown visibility as no", () => {
    expect(corpusConsent({ visibility: "unknown" })).toBe(false);
    expect(corpusConsent({ visibility: "unknown", optIn: true })).toBe(false);
  });
});
