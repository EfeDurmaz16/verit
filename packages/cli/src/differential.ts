import { execFile } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { promisify } from "node:util";
import type { Claim, ClaimSources } from "@verit/domain";
import {
  generateJobSpecKeypair,
  probeSourceHash,
  signJobSpecAsymmetric,
} from "@verit/application";
import type { DifferentialReviewDeps, ProbeExecution } from "@verit/application";
import { runDifferentialIsolated } from "@verit/adapter-prove";
import type { CorpusStore } from "@verit/ports";
import { laneClientFor, laneConfigFromEnv, runClaimPass, runProbePass, toProbeSpec } from "@verit/lane";

/*
 * The real dependencies of a differential review, on one machine.
 *
 * Everything here is a thin adapter over something that already exists: the
 * lane for the two model passes, git for what the repository ships, and
 * @verit/adapter-prove for the run itself. The orchestration lives in
 * @verit/application where it can be tested with fakes; this file only supplies
 * the real ends of it, so there is nowhere here for a decision to hide.
 */

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const GIT_BUFFER = 16 * 1024 * 1024;

const git = async (args: readonly string[], cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await exec("git", [...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_BUFFER,
    });
    return stdout;
  } catch {
    return null;
  }
};

export interface DifferentialCliDeps {
  readonly repoDir: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly jobId: string;
  readonly repo: string;
  readonly pullRequest: string;
  /** The planner's private key. Never leaves this process. */
  readonly privateKey: string;
  /** The public half, handed to the runner. Not a secret. */
  readonly publicKey: string;
  readonly corpus?: CorpusStore | null;
}

/**
 * The planner's signing keypair.
 *
 * A configured key makes a spec portable: a sink or a second machine can check
 * it later. Without one an ephemeral pair is generated per run, which still
 * binds the spec to this run and this probe, and simply cannot be verified
 * anywhere else. That is the honest local default, and it is why the key is an
 * input rather than something invented and stored.
 */
export const jobSpecKeys = (env: NodeJS.ProcessEnv = process.env) => {
  const configured = env.VERIT_JOB_SPEC_PRIVATE_KEY;
  if (configured !== undefined && configured !== "") {
    return {
      privateKey: configured,
      publicKey: createPublicKey(configured).export({ type: "spki", format: "pem" }).toString(),
    };
  }
  return generateJobSpecKeypair();
};

/**
 * Whether a differential review can run at all here.
 *
 * Both model passes need a lane, and the comparison needs two commits. Missing
 * either is an ordinary situation, not an error: the run reports what it did
 * measure and says nothing about what it could not.
 */
export const differentialAvailable = (input: {
  baseSha?: string | null;
  headSha?: string | null;
}): boolean => {
  const config = (() => {
    try {
      return laneConfigFromEnv();
    } catch {
      return null;
    }
  })();
  return (
    config !== null &&
    typeof input.baseSha === "string" &&
    input.baseSha !== "" &&
    typeof input.headSha === "string" &&
    input.headSha !== ""
  );
};

export const makeDifferentialDeps = (input: DifferentialCliDeps): DifferentialReviewDeps => {
  const config = laneConfigFromEnv();
  const client = laneClientFor(config);

  return {
    claimPass: (sources: ClaimSources) => runClaimPass(client, sources),

    probePass: async ({ claim, netDiff, repoContext, existingTests }) => {
      const generated = await runProbePass(client, {
        claim,
        netDiff,
        ...(repoContext !== undefined ? { repoContext } : {}),
        existingTests,
      });
      return generated.map((g) => {
        const spec = toProbeSpec(g, "pending");
        const { id: _id, asserts: _asserts, ...rest } = spec;
        return rest;
      });
    },

    listRepoFiles: async () => {
      const out = await git(["ls-tree", "-r", "--name-only", input.headSha], input.repoDir);
      return out === null ? [] : out.split("\n").filter((l) => l !== "");
    },

    readAtHead: async (path: string) => {
      // `git show` rather than the working tree: the bytes that belong to the
      // head commit, not whatever a previous step left on disk.
      return git(["show", `${input.headSha}:${path}`], input.repoDir);
    },

    execute: async ({ probe, policy, runsPerSide, prepare }): Promise<ProbeExecution> => {
      // Never runDifferential from here. This process holds the model key and
      // the GitHub token, and a probe reads its parent's environment, so the
      // run has to start one process further down where there is nothing to
      // read. runDifferential itself refuses if called from here, which is how
      // that stays true rather than being a convention.
      const spec = {
        id: probe.id,
        source: probe.source,
        origin: probe.origin,
        kind: probe.kind,
        fileName: probe.fileName,
        ...(probe.installPath !== undefined ? { installPath: probe.installPath } : {}),
        command: probe.command,
        args: [...probe.args],
      };
      const probeHashes = [probeSourceHash(probe.source)];
      const binding = {
        jobId: input.jobId,
        repo: input.repo,
        pullRequest: input.pullRequest,
        baseSha: input.baseSha,
        headSha: input.headSha,
        policyDigest: policy.digest,
        probeHashes,
      };
      const out = await runDifferentialIsolated({
        job: {
          repoDir: input.repoDir,
          baseSha: input.baseSha,
          headSha: input.headSha,
          probe: spec,
          policy,
          runsPerSide,
          prepare,
          jobSpec: signJobSpecAsymmetric(binding, input.privateKey),
          publicKey: input.publicKey,
          binding,
        },
      });
      if (out.run === undefined) {
        throw new Error(`the isolated runner produced no result: ${out.problems.join("; ")}`);
      }
      return {
        base: out.run.base,
        head: out.run.head,
        sides: out.run.sides,
        probeHeldOutside: out.run.probeHeldOutside,
        observedProbeHashes: out.run.observedProbeHashes,
      };
    },

    ...(input.corpus != null ? { corpus: input.corpus } : {}),
  };
};

/** The claim material, assembled from what the review already fetched. */
export const claimSourcesFrom = (input: {
  title: string;
  body: string;
  diff: string;
  repoContext?: string;
}): ClaimSources => ({
  prDescription: `${input.title}\n\n${input.body}`,
  diff: input.diff,
  ...(input.repoContext !== undefined ? { repoContext: input.repoContext } : {}),
});

/** Claims a run ended up with, for the log line the operator reads. */
export const describeClaims = (claims: readonly Claim[]): string =>
  claims.length === 0
    ? "no claims"
    : claims
        .map((c) => `${c.state === "ambiguous" ? "ambiguous" : "grounded"}: ${c.statement}`)
        .join("; ");
