import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Claim, ClaimSources } from "@verit/domain";
import type { DifferentialReviewDeps, ProbeExecution } from "@verit/application";
import { PROBE_PATH_TOKEN, runDifferential } from "@verit/adapter-prove";
import type { CorpusStore } from "@verit/ports";
import {
  clientForModel,
  laneClientFor,
  laneConfigFromEnv,
  runClaimPass,
  runProbePass,
  toProbeSpec,
} from "@verit/lane";

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
  readonly corpus?: CorpusStore | null;
}

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
  // Both passes here are map work, not judgement. Naming the claims a change
  // makes and writing a probe for one are reading tasks over material that is
  // already in front of the model, and the tier already keeps a cheap
  // big-context model for exactly that. The judge is reserved for the call
  // whose output is an opinion. On the balanced tier this is most of the cost
  // of a review: the same run drops from about 22 cents to 12 on a mid sized
  // pull request, and from 67 to 37 on a large one.
  //
  // A tier with no triage model, `fast`, has nothing cheaper to fall back to,
  // so it uses its judge, which is already the cheap model there.
  const mapClient = config.triage !== undefined
    ? clientForModel(config, config.triage)
    : laneClientFor(config);

  return {
    claimPass: (sources: ClaimSources) => runClaimPass(mapClient, sources),

    probePass: async ({ claim, netDiff, repoContext, existingTests }) => {
      const generated = await runProbePass(mapClient, {
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
      const run = await runDifferential({
        repoDir: input.repoDir,
        baseSha: input.baseSha,
        headSha: input.headSha,
        probe: {
          id: probe.id,
          source: probe.source,
          origin: probe.origin,
          kind: probe.kind,
          fileName: probe.fileName,
          ...(probe.installPath !== undefined ? { installPath: probe.installPath } : {}),
          command: probe.command,
          args: probe.args.map((a) => (a === PROBE_PATH_TOKEN ? PROBE_PATH_TOKEN : a)),
        },
        policy,
        runsPerSide,
        prepare,
      });
      return {
        base: run.base,
        head: run.head,
        sides: run.sides,
        probeHeldOutside: run.probeHeldOutside,
        observedProbeHashes: run.observedProbeHashes,
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
