import { DatabaseSync } from "node:sqlite";
import { type Claim, type ClaimSources, verifyBundle } from "@verit/domain";
import { makeSqliteCorpusStore, migrateSqlite } from "@verit/adapter-sqlite";
import type { ProveCommand } from "@verit/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type DifferentialReviewDeps,
  type DifferentialReviewInput,
  type ProbeExecution,
  type RunnableProbe,
  runDifferentialReview,
} from "./differential-review";

/*
 * The order is the thing under test.
 *
 * Each piece below was verified on its own. What can still go wrong is the
 * sequence: running a probe for a claim nobody grounded, generating one the
 * repository already had, executing before the spec is signed, or remembering
 * a run nobody consented to. So these tests watch what got called, not only
 * what came back.
 */

const suite: ProveCommand = { command: "npx", args: ["vitest", "run"], source: "package.json" };

const SOURCES: ClaimSources = {
  issue: "Uploads fail on a transient 503.",
  prDescription: "Retry the upload once.",
  diff: "--- a/src/upload.ts\n+++ b/src/upload.ts\n+  await retryOnce(send);\n",
};

const groundedClaim: Claim = {
  id: "claim:1",
  statement: "The upload retries once on a transient failure.",
  state: "source-grounded",
  anchors: [{ kind: "issue", ref: "#1", span: "transient 503" }],
  modelConfidence: 0.6,
  regions: ["src/upload.ts"],
};

const side = (s: "base" | "head", state: "pass" | "fail") => ({
  side: s,
  state,
  exitCode: state === "pass" ? 0 : 1,
  runs: 2,
  observedStates: [state, state] as const,
  artifactRefs: [`artifact://${s}.log`],
});

const execution = (baseState: "pass" | "fail", headState: "pass" | "fail"): ProbeExecution => ({
  base: { ...side("base", baseState), observedStates: [baseState, baseState] },
  head: { ...side("head", headState), observedStates: [headState, headState] },
  sides: [
    {
      side: "base",
      sha: "aaaa",
      selectedToolchain: "node@22",
      resolvedDependencies: "package.json@x",
      environmentDigest: "env-base",
    },
    {
      side: "head",
      sha: "bbbb",
      selectedToolchain: "node@22",
      resolvedDependencies: "package.json@x",
      environmentDigest: "env-head",
    },
  ],
  probeHeldOutside: true,
  observedProbeHashes: { base: "", head: "" },
});

interface Trace {
  claimPass: number;
  probePass: string[];
  executed: RunnableProbe[];
}

const harness = (over: Partial<DifferentialReviewDeps> = {}, trace: Trace) => {
  const deps: DifferentialReviewDeps = {
    claimPass: async () => {
      trace.claimPass += 1;
      return [groundedClaim];
    },
    probePass: async ({ claim }) => {
      trace.probePass.push(claim.id);
      return [
        {
          source: "process.exit(0)",
          origin: "generated",
          kind: "behavioral",
          fileName: "probe.mjs",
          command: "node",
          args: ["{probe}"],
        },
      ];
    },
    listRepoFiles: async () => ["package.json", "src/upload.ts"],
    readAtHead: async () => "expect(retryOnce).toBeCalled()",
    execute: async ({ probe }) => {
      trace.executed.push(probe);
      // the runner reports the hash it observed, which the orchestrator
      // compares against the source it handed over
      const hash = (await import("node:crypto"))
        .createHash("sha256")
        .update(probe.source)
        .digest("hex");
      const out = execution("pass", "fail");
      return { ...out, observedProbeHashes: { base: hash, head: hash } };
    },
    ...over,
  };
  return deps;
};

const input = (over: Partial<DifferentialReviewInput> = {}): DifferentialReviewInput => ({
  repoId: "repo-1",
  repo: "EfeDurmaz16/verit",
  pullRequest: "EfeDurmaz16/verit#10",
  jobId: "job-1",
  baseSha: "aaaa",
  headSha: "bbbb",
  sources: SOURCES,
  detectedSuites: [suite],
  changedRegions: ["src/upload.ts", "src/unrelated.ts"],
  changedFiles: 2,
  changedLines: 40,
  visibility: "public",
  signingSecret: "planning-plane-secret",
  ...over,
});

const newTrace = (): Trace => ({ claimPass: 0, probePass: [], executed: [] });

describe("nothing executes before there is something grounded to measure", () => {
  it("stops at needs-claim without running a probe", async () => {
    const trace = newTrace();
    const deps = harness(
      { claimPass: async () => [{ ...groundedClaim, state: "ambiguous" as const }] },
      trace,
    );
    const out = await runDifferentialReview(deps)(input());
    expect(out.bundle.readiness).toBe("needs-claim");
    expect(out.stoppedEarly).toBe("no grounded claim");
    expect(trace.executed).toEqual([]);
    expect(trace.probePass).toEqual([]);
  });

  it("stops when the repository verifies nothing, and says what is missing", async () => {
    const trace = newTrace();
    const out = await runDifferentialReview(harness({}, trace))(input({ detectedSuites: [] }));
    expect(out.stoppedEarly).toContain("no way this repository verifies itself");
    expect(trace.executed).toEqual([]);
  });
});

describe("the repository is asked before anything is generated", () => {
  it("uses the repository's own test and does not call the probe writer", async () => {
    const trace = newTrace();
    const deps = harness({ listRepoFiles: async () => ["src/upload.ts", "src/upload.test.ts"] }, trace);
    const out = await runDifferentialReview(deps)(input());
    expect(trace.probePass).toEqual([]);
    expect(trace.executed[0]?.origin).toBe("repo-native");
    expect(out.bundle.probes[0]?.origin).toBe("repo-native");
  });

  it("takes the repo-native probe's bytes from head, then holds them in custody", async () => {
    const trace = newTrace();
    const deps = harness(
      {
        listRepoFiles: async () => ["src/upload.ts", "src/upload.test.ts"],
        readAtHead: async () => "the head version of the test",
      },
      trace,
    );
    await runDifferentialReview(deps)(input());
    expect(trace.executed[0]?.source).toBe("the head version of the test");
    expect(trace.executed[0]?.installPath).toBe("src/upload.test.ts");
  });

  it("generates only for a claim the repository said nothing about", async () => {
    const trace = newTrace();
    const out = await runDifferentialReview(harness({}, trace))(input());
    expect(trace.probePass).toEqual(["claim:1"]);
    expect(out.bundle.probes[0]?.origin).toBe("generated");
  });

  it("reports no probe rather than inventing coverage", async () => {
    const trace = newTrace();
    const deps = harness({ probePass: async () => [] }, trace);
    const out = await runDifferentialReview(deps)(input());
    expect(out.stoppedEarly).toBe("no probe");
    expect(out.bundle.readiness).toBe("needs-evidence");
    expect(trace.executed).toEqual([]);
  });
});

describe("what comes back is what the outcomes said", () => {
  it("classifies a regression and produces a bundle that verifies against itself", async () => {
    const trace = newTrace();
    const out = await runDifferentialReview(harness({}, trace))(input());
    expect(out.bundle.results[0]?.classification).toBe("regression");
    expect(out.bundle.coverage[0]?.status).toBe("contradicted");
    expect(verifyBundle(out.bundle)).toEqual([]);
  });

  it("refuses to grade a run whose probe did not survive both sides", async () => {
    const trace = newTrace();
    const deps = harness(
      {
        execute: async ({ probe }) => {
          trace.executed.push(probe);
          return { ...execution("pass", "fail"), observedProbeHashes: { base: "aa", head: "bb" } };
        },
      },
      trace,
    );
    const out = await runDifferentialReview(deps)(input());
    expect(out.bundle.results[0]?.grade).toBeNull();
    expect(out.bundle.readiness).toBe("inconclusive");
  });

  it("carries a replay command bound to this run's spec", async () => {
    const out = await runDifferentialReview(harness({}, newTrace()))(input());
    expect(out.bundle.reproduction.replayCommand).toContain("EfeDurmaz16/verit#10");
    expect(out.bundle.reproduction.replayCommand).toContain("--spec ");
    expect(out.bundle.reproduction.probeHashes).toHaveLength(1);
  });

  it("names the changed regions no claim spoke for", async () => {
    const out = await runDifferentialReview(harness({}, newTrace()))(input());
    expect(out.graph.uncoveredRegions).toEqual(["src/unrelated.ts"]);
    expect(out.measurement.stratum).toBe("ordinary");
  });
});

describe("nothing is remembered without consent", () => {
  const withCorpus = async (over: Partial<DifferentialReviewInput>) => {
    const db = new DatabaseSync(":memory:");
    migrateSqlite(db);
    const corpus = makeSqliteCorpusStore(db);
    await runDifferentialReview(harness({ corpus }, newTrace()))(input(over));
    return Effect.runPromise(corpus.exportRepo("repo-1"));
  };

  it("remembers a public repository's outcome", async () => {
    const stored = await withCorpus({ visibility: "public" });
    expect(stored.outcomes).toHaveLength(1);
    expect(stored.outcomes[0]?.classification).toBe("regression");
  });

  it("remembers nothing for a public repository that opted out", async () => {
    expect((await withCorpus({ visibility: "public", corpusOptOut: true })).outcomes).toEqual([]);
  });

  it("remembers nothing for a private repository until it opts in", async () => {
    expect((await withCorpus({ visibility: "private" })).outcomes).toEqual([]);
    expect((await withCorpus({ visibility: "private", corpusOptIn: true })).outcomes).toHaveLength(1);
  });

  it("stores the probe hash and never the probe", async () => {
    const stored = await withCorpus({ visibility: "public" });
    expect(stored.outcomes[0]?.probeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("process.exit");
  });
});
