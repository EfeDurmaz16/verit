import { Effect } from "effect";
import {
  type Claim,
  type ClaimProbeEdge,
  type ClaimSources,
  type EvidenceBundle,
  type EvidenceGrade,
  type ExecutionMemoryRecord,
  type Probe,
  type ReproductionManifest,
  type SideOutcome,
  type SideRecord,
  corpusConsent,
  normalizeOutcome,
} from "@verit/domain";
import type { CorpusStore, ProveCommand } from "@verit/ports";
import { type ProbeRun, assembleEvidence } from "./evidence-check";
import { type ClaimGraph, buildClaimGraph, measureCoverage } from "./claim-graph";
import type { CoverageMeasurement } from "./claim-graph";
import { type JobSpecBinding, probeSourceHash, signJobSpec } from "./jobspec";
import { type ManagedExecution, resolveManagedExecution } from "./managed-execution";
import { scopeRunnerToFile, selectRepoNativeProbes } from "./probe-select";

/*
 * The whole run, in one place.
 *
 * Everything below this line has been unit tested on its own. What this file
 * adds is the order, and the order is where a review tool usually starts
 * cheating: it runs the model, likes the answer, and skips the checks that
 * would have contradicted it. So the sequence is fixed and each step can only
 * narrow what the next one is allowed to say.
 *
 *   claims are grounded before any probe is chosen
 *   the repository's own tests are asked for before anything is generated
 *   the spec is signed over the run before any probe executes
 *   classification comes from the outcomes, never from the model
 *   nothing is remembered unless consent said so
 *
 * The expensive step is execution, so it is the last one and it does not
 * happen at all when there is nothing grounded to measure. A run that asks for
 * a sentence costs one model call.
 */

/** A probe ready to hand to the runner. Mirrors @verit/adapter-prove ProbeSpec. */
export interface RunnableProbe {
  readonly id: string;
  readonly source: string;
  readonly origin: Probe["origin"];
  readonly kind: Probe["kind"];
  readonly fileName: string;
  readonly installPath?: string;
  /** Repo-relative directory the runner starts in. Empty means the root. */
  readonly cwd?: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Why this probe exists, for the evidence body. */
  readonly reason: string;
}

/** What the runner gives back. Mirrors @verit/adapter-prove DifferentialRun. */
export interface ProbeExecution {
  readonly base: SideOutcome;
  readonly head: SideOutcome;
  readonly sides: readonly [SideRecord, SideRecord];
  readonly probeHeldOutside: boolean;
  readonly observedProbeHashes: { readonly base: string; readonly head: string };
}

export interface DifferentialReviewDeps {
  /** One model call. Returns grounded claims, or none. */
  readonly claimPass: (sources: ClaimSources) => Promise<readonly Claim[]>;
  /** One model call per uncovered claim. Returns probes, or none. */
  readonly probePass: (input: {
    claim: Claim;
    netDiff: string;
    repoContext?: string;
    existingTests: readonly string[];
  }) => Promise<readonly Omit<RunnableProbe, "id" | "reason">[]>;
  /** Every path the repository ships at head. */
  readonly listRepoFiles: () => Promise<readonly string[]>;
  /** A file's bytes at the head commit, or null when it is not there. */
  readonly readAtHead: (path: string) => Promise<string | null>;
  /** Run one probe on base and head. */
  readonly execute: (input: {
    probe: RunnableProbe;
    policy: ManagedExecution["policy"];
    runsPerSide: number;
    prepare: ProveCommand | null;
  }) => Promise<ProbeExecution>;
  readonly corpus?: CorpusStore | null;
  /** A previous install that worked, when the corpus has one. */
  readonly rememberedInstall?: ExecutionMemoryRecord | null;
  readonly stabilityHistory?: (probeHash: string) => Promise<{ runs: number; unstable: number } | null>;
}

export interface DifferentialReviewInput {
  readonly repoId: string;
  readonly repo: string;
  readonly pullRequest: string;
  readonly jobId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly sources: ClaimSources;
  readonly detectedSuites: readonly ProveCommand[];
  readonly changedRegions: readonly string[];
  readonly changedFiles: number;
  readonly changedLines: number;
  readonly repoContext?: string;
  readonly visibility: "public" | "private" | "unknown";
  readonly corpusOptOut?: boolean;
  readonly corpusOptIn?: boolean;
  readonly signingSecret: string;
  readonly requiredGrade?: EvidenceGrade;
  readonly imageDigest?: string;
  readonly overrideInstall?: ProveCommand | null;
}

export interface DifferentialReviewResult {
  readonly bundle: EvidenceBundle;
  readonly graph: ClaimGraph;
  readonly measurement: CoverageMeasurement;
  readonly execution: ManagedExecution;
  /** Set when the run stopped before executing anything, with the reason. */
  readonly stoppedEarly: string | null;
}

const emptyManifest = (imageDigest: string): ReproductionManifest => ({
  environmentDigest: "",
  imageDigest,
  toolchainPins: [],
  probeHashes: [],
  artifactRefs: [],
  replayCommand: "",
});

export const runDifferentialReview =
  (deps: DifferentialReviewDeps) =>
  async (input: DifferentialReviewInput): Promise<DifferentialReviewResult> => {
    const imageDigest = input.imageDigest ?? "unpinned";

    // 1. Claims first, and grounded by the pass itself. A run with nothing
    //    grounded has nothing to measure, and measuring anyway would be
    //    picking a probe for a sentence nobody stands behind.
    const claims = await deps.claimPass(input.sources);
    const grounded = claims.filter(
      (c) => c.state === "source-grounded" || c.state === "author-confirmed",
    );

    const execution = resolveManagedExecution({
      repoFiles: await deps.listRepoFiles(),
      detectedSuites: input.detectedSuites,
      rememberedInstall: deps.rememberedInstall ?? null,
      overrideInstall: input.overrideInstall ?? null,
    });

    const finish = (
      probes: readonly RunnableProbe[],
      edges: readonly ClaimProbeEdge[],
      runs: readonly ProbeRun[],
      manifest: ReproductionManifest,
      jobSpecVerified: boolean,
      sides: readonly [SideRecord, SideRecord],
      stoppedEarly: string | null,
    ): DifferentialReviewResult => {
      const bundle = assembleEvidence({
        pullRequest: input.pullRequest,
        claims,
        edges,
        runs,
        policy: execution.policy,
        jobSpec: signJobSpec(
          {
            jobId: input.jobId,
            repo: input.repo,
            pullRequest: input.pullRequest,
            baseSha: input.baseSha,
            headSha: input.headSha,
            policyDigest: execution.policy.digest,
            probeHashes: probes.map((p) => probeSourceHash(p.source)),
          },
          input.signingSecret === "" ? "unsigned-local-run" : input.signingSecret,
        ),
        jobSpecVerified,
        sides,
        reproduction: manifest,
        ...(input.requiredGrade !== undefined ? { requiredGrade: input.requiredGrade } : {}),
      });
      const graph = buildClaimGraph({
        claims,
        edges,
        coverage: bundle.coverage,
        changedRegions: input.changedRegions,
        changedFiles: input.changedFiles,
        changedLines: input.changedLines,
      });
      return {
        bundle,
        graph,
        measurement: measureCoverage({ graph, results: bundle.results }),
        execution,
        stoppedEarly,
      };
    };

    const placeholderSides: readonly [SideRecord, SideRecord] = [
      {
        side: "base",
        sha: input.baseSha,
        selectedToolchain: "",
        resolvedDependencies: "",
        environmentDigest: "",
      },
      {
        side: "head",
        sha: input.headSha,
        selectedToolchain: "",
        resolvedDependencies: "",
        environmentDigest: "",
      },
    ];

    if (grounded.length === 0) {
      return finish([], [], [], emptyManifest(imageDigest), false, placeholderSides, "no grounded claim");
    }
    if (execution.needsMaintainerInput !== null) {
      return finish(
        [],
        [],
        [],
        emptyManifest(imageDigest),
        false,
        placeholderSides,
        execution.needsMaintainerInput,
      );
    }

    // 2. Ask the repository before generating anything. Its own tests are the
    //    probes its maintainers already trust.
    const repoFiles = await deps.listRepoFiles();
    const candidates = selectRepoNativeProbes({ claims: grounded, repoFiles });

    const probes: RunnableProbe[] = [];
    const edges: ClaimProbeEdge[] = [];
    let n = 0;

    for (const candidate of candidates) {
      // The bytes come from head and are then held in custody, so the branch's
      // own edit of a test cannot decide the answer.
      const source = await deps.readAtHead(candidate.path);
      if (source === null || source === "") continue;
      const suite = input.detectedSuites[0];
      if (suite === undefined) continue;
      // A runner that cannot be narrowed runs the whole suite from the root:
      // coarser, still honest.
      const scoped = scopeRunnerToFile(suite, candidate.path, repoFiles);
      n += 1;
      const id = `probe:${n}`;
      probes.push({
        id,
        source,
        origin: "repo-native",
        kind: "behavioral",
        fileName: candidate.path.split("/").pop() ?? "probe",
        installPath: candidate.path,
        ...(scoped !== null && scoped.cwd !== "" ? { cwd: scoped.cwd } : {}),
        command: scoped?.command.command ?? suite.command,
        args: scoped?.command.args ?? suite.args,
        reason: candidate.reason,
      });
      for (const claimId of candidate.claimIds) {
        edges.push({ claimId, probeId: id, role: "primary" });
      }
    }

    // 3. Generate only for claims the repository said nothing about.
    const covered = new Set(edges.map((e) => e.claimId));
    for (const claim of grounded) {
      if (covered.has(claim.id)) continue;
      const generated = await deps.probePass({
        claim,
        netDiff: input.sources.diff,
        ...(input.repoContext !== undefined ? { repoContext: input.repoContext } : {}),
        existingTests: candidates.map((c) => c.path),
      });
      for (const g of generated) {
        n += 1;
        const id = `probe:${n}`;
        probes.push({ ...g, id, reason: "written for this claim" });
        edges.push({
          claimId: claim.id,
          probeId: id,
          role: g.kind === "precondition" ? "precondition" : "primary",
        });
      }
    }

    if (probes.length === 0) {
      return finish([], edges, [], emptyManifest(imageDigest), false, placeholderSides, "no probe");
    }

    // 4. Sign the spec over this run, then execute. The signature is what the
    //    execution job checks before it runs anything at all.
    const probeHashes = probes.map((p) => probeSourceHash(p.source));
    const binding: JobSpecBinding = {
      jobId: input.jobId,
      repo: input.repo,
      pullRequest: input.pullRequest,
      baseSha: input.baseSha,
      headSha: input.headSha,
      policyDigest: execution.policy.digest,
      probeHashes,
    };
    const secret = input.signingSecret === "" ? "unsigned-local-run" : input.signingSecret;
    const spec = signJobSpec(binding, secret);

    const runs: ProbeRun[] = [];
    let sides: readonly [SideRecord, SideRecord] = placeholderSides;
    const artifactRefs: string[] = [];

    for (const probe of probes) {
      const history = (await deps.stabilityHistory?.(probeSourceHash(probe.source))) ?? null;
      const runsPerSide = history !== null && history.unstable > 0 ? execution.runsPerSide + 1 : execution.runsPerSide;
      const out = await deps.execute({
        probe,
        policy: execution.policy,
        runsPerSide,
        prepare: execution.prepare,
      });
      sides = out.sides;
      artifactRefs.push(...out.base.artifactRefs, ...out.head.artifactRefs);
      const expected = probeSourceHash(probe.source);
      runs.push({
        probe: {
          id: probe.id,
          source: probe.source,
          hash: expected,
          origin: probe.origin,
          kind: probe.kind,
        },
        base: out.base,
        head: out.head,
        probeHeldOutside: out.probeHeldOutside,
        sameProbeHashBothSides:
          out.observedProbeHashes.base === expected && out.observedProbeHashes.head === expected,
        ...(probe.kind === "precondition"
          ? {
              precondition: {
                probeId: probe.id,
                baseAbsenceProven: out.base.state === "absent-by-design",
              },
            }
          : {}),
      });
    }

    const manifest: ReproductionManifest = {
      environmentDigest: sides[1].environmentDigest,
      imageDigest,
      toolchainPins: [sides[0].selectedToolchain, sides[1].selectedToolchain].filter(
        (t) => t !== "",
      ),
      probeHashes,
      artifactRefs,
      replayCommand: `verit replay ${input.pullRequest} --base ${input.baseSha} --head ${input.headSha} --spec ${spec.specHash}`,
    };

    const result = finish(probes, edges, runs, manifest, true, sides, null);

    // 5. Remember, only if consent said so, and only facts.
    if (
      deps.corpus != null &&
      corpusConsent({
        visibility: input.visibility,
        ...(input.corpusOptOut !== undefined ? { optOut: input.corpusOptOut } : {}),
        ...(input.corpusOptIn !== undefined ? { optIn: input.corpusOptIn } : {}),
      })
    ) {
      const corpus = deps.corpus;
      for (const r of result.bundle.results) {
        const probe = probes.find((p) => p.id === r.probeId);
        if (probe === undefined) continue;
        const record = normalizeOutcome({
          repoId: input.repoId,
          probeHash: probeSourceHash(probe.source),
          probeOrigin: probe.origin,
          baseState: r.base.state,
          headState: r.head.state,
          classification: r.classification,
          grade: r.grade,
          runsPerSide: r.head.runs,
          stable: r.gates.stabilityChecked,
        });
        // Remembering is a convenience, never a reason to fail a run that
        // already produced its evidence. A corpus that is down costs a future
        // hint, not this maintainer's answer.
        await Effect.runPromise(Effect.either(corpus.recordOutcome(record)));
      }
    }

    return result;
  };
