import { execFile } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { promisify } from "node:util";
import type { Claim, ClaimSources } from "@verit/domain";
import {
  generateJobSpecKeypair,
  probeSourceHash,
  signJobSpecAsymmetric,
} from "@verit/application";
import type {
  DifferentialReviewDeps,
  ProbeExecution,
  RunnableProbe,
} from "@verit/application";
import { runDifferentialIsolated } from "@verit/adapter-prove";
import { makeTreeSitterParser } from "@verit/adapter-treesitter";
import { Effect } from "effect";
import type { CorpusStore } from "@verit/ports";
import { laneClientFor, laneConfigFromEnv, runClaimPass, runProbeBatch,
  runProbePass, toProbeSpec } from "@verit/lane";

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
/** Ceilings on the index. A slice is context, not a reason to read the repo. */
const MAX_INDEXED_FILES = 400;
const MAX_INDEXED_BYTES = 400_000;

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

/** The runnable shape, minus the fields the orchestrator assigns itself. */
const stripSpec = (
  spec: ReturnType<typeof toProbeSpec>,
): Omit<RunnableProbe, "id" | "reason"> => {
  const { id: _id, asserts: _asserts, ...rest } = spec;
  return rest;
};

export const makeDifferentialDeps = (input: DifferentialCliDeps): DifferentialReviewDeps => {
  const config = laneConfigFromEnv();
  const client = laneClientFor(config);

  return {
    claimPass: (sources: ClaimSources) => runClaimPass(client, sources),

    probePass: async ({ claim, netDiff, repoContext, existingTests, runtime, kind }) => {
      const generated = await runProbePass(client, {
        claim,
        netDiff,
        ...(repoContext !== undefined ? { repoContext } : {}),
        existingTests,
        ...(runtime !== undefined ? { runtime } : {}),
      });
      return generated.map((g) => stripSpec(toProbeSpec(g, "pending", kind)));
    },

    // Present only when the operator asked for it, so the default stays the
    // per-claim path the measurements were taken on.
    ...(process.env.VERIT_PROBE_BATCH === "1"
      ? {
          probeBatch: async (inputs) => {
            const byId = new Map(inputs.map((i) => [i.claim.id, i]));
            const batched = await runProbeBatch(
              client,
              inputs.map((i) => ({
                claim: i.claim,
                netDiff: i.netDiff,
                ...(i.repoContext !== undefined ? { repoContext: i.repoContext } : {}),
                existingTests: i.existingTests,
                ...(i.runtime !== undefined ? { runtime: i.runtime } : {}),
              })),
            );
            const out = new Map<string, readonly Omit<RunnableProbe, "id" | "reason">[]>();
            for (const [claimId, probes] of batched) {
              const kind = byId.get(claimId)?.kind ?? "behavioral";
              out.set(claimId, probes.map((g) => stripSpec(toProbeSpec(g, "pending", kind))));
            }
            return out;
          },
        }
      : {}),

    listRepoFiles: async () => {
      const out = await git(["ls-tree", "-r", "--name-only", input.headSha], input.repoDir);
      return out === null ? [] : out.split("\n").filter((l) => l !== "");
    },

    readAtHead: async (path: string) => {
      // `git show` rather than the working tree: the bytes that belong to the
      // head commit, not whatever a previous step left on disk.
      return git(["show", `${input.headSha}:${path}`], input.repoDir);
    },

    /**
     * Symbols and imports for the files a slice can reach.
     *
     * Two phases, because parsing a repository to answer a question about six
     * files is the wrong trade. First the files the claims name. Then the ones
     * that mention them, found with a literal search rather than a parse, and
     * only those get parsed.
     */
    buildIndex: async ({ focusPaths }) => {
      const parser = makeTreeSitterParser();
      const stems = [
        ...new Set(
          focusPaths
            .map((p) => (p.split("/").pop() ?? p).replace(/\.[^.]+$/, ""))
            .filter((x) => x !== ""),
        ),
      ];
      const candidates = new Set<string>(focusPaths);
      for (const stem of stems) {
        // -F: the stem is a literal, not a pattern. A file name with a dot or a
        // dash would otherwise quietly become a wildcard.
        const hits = await git(["grep", "-l", "-F", "--", stem, input.headSha], input.repoDir);
        if (hits === null) continue;
        for (const line of hits.split("\n")) {
          // `git grep <rev>` prefixes each path with the revision.
          const path = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
          if (path !== "" && candidates.size < MAX_INDEXED_FILES) candidates.add(path);
        }
      }

      const files = [];
      for (const path of candidates) {
        const source = await git(["show", `${input.headSha}:${path}`], input.repoDir);
        if (source === null || source.length > MAX_INDEXED_BYTES) continue;
        const symbols = await Effect.runPromise(
          Effect.either(parser.extractSymbols(path, source)),
        );
        if (symbols._tag === "Left") continue;
        files.push({ path, symbols: [...symbols.right] });
      }
      return { files };
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
        ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
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
