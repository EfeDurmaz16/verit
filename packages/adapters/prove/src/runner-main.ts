import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runDifferential } from "./differential";
import type { DifferentialRun, ProbeSpec } from "./differential";
import { secretsIn } from "./runner-env";

/*
 * The untrusted side of the run, as its own process.
 *
 * Scrubbing a child's environment is not enough on its own. A probe on Linux
 * can read /proc/<ppid>/environ, so whatever process spawns it is as exposed as
 * the probe is. If that process is the verit CLI, the model key and the GitHub
 * token are one file read away.
 *
 * So the probes are spawned by this process instead, and this process is
 * started with an environment that never had a secret in it. The probe's parent
 * is now something with nothing worth stealing.
 *
 * What this process holds:
 *   the job file, the probe source, a public key, one write-only capability
 * What it does not hold:
 *   the model key, the GitHub token, the ingest token, the signing private key
 *
 * It verifies the job spec itself rather than trusting the caller, and it
 * re-hashes the probe bytes it was handed rather than trusting the manifest,
 * because a runner that takes its instructions on faith is not a boundary.
 *
 * ponytail: this is process-level separation, not a sandbox. A probe can still
 * walk further up /proc to this process's own parent. Closing that needs a
 * namespace or a separate user, which is what the managed execution path is
 * for; on a customer's own runner the job is already the isolation they chose.
 */

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Everything the untrusted side is allowed to know. Nothing here authorizes. */
export interface RunnerJob {
  readonly repoDir: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly probe: ProbeSpec;
  readonly policy: { orchestration: string; isolation: string; digest: string };
  readonly runsPerSide?: number;
  readonly timeoutMs?: number;
  readonly prepare?: { command: string; args: readonly string[]; source: string } | null;
  /** The signed instruction. Verified here, not taken on trust. */
  readonly jobSpec: { specHash: string; signature: string; probeHashes: readonly string[] };
  /** The planner's public key. Not a secret, which is the point. */
  readonly publicKey: string;
  /** The binding the spec must have been signed over. */
  readonly binding: {
    jobId: string;
    repo: string;
    pullRequest: string;
    baseSha: string;
    headSha: string;
    policyDigest: string;
    probeHashes: readonly string[];
  };
}

export interface RunnerResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly run?: DifferentialRun;
}

/**
 * Check the instruction before acting on it.
 *
 * Duplicated deliberately rather than imported from @verit/application: this
 * process must not depend on the planning side to decide whether its own
 * instruction is valid, and the check is small enough that a second
 * implementation is cheaper than the coupling.
 */
export const verifyJob = async (job: RunnerJob): Promise<readonly string[]> => {
  const problems: string[] = [];

  const canonical = [
    `job=${job.binding.jobId}`,
    `repo=${job.binding.repo}`,
    `pr=${job.binding.pullRequest}`,
    `base=${job.binding.baseSha}`,
    `head=${job.binding.headSha}`,
    `policy=${job.binding.policyDigest}`,
    `probes=${[...job.binding.probeHashes].sort().join(",")}`,
  ].join("\n");
  if (sha256(canonical) !== job.jobSpec.specHash) {
    problems.push("the spec was signed over a different run than this job describes");
  }

  const { createPublicKey, verify } = await import("node:crypto");
  let signatureOk = false;
  try {
    signatureOk = verify(
      null,
      Buffer.from(job.jobSpec.specHash, "hex"),
      createPublicKey(job.publicKey),
      Buffer.from(job.jobSpec.signature, "hex"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) problems.push("the signature does not verify under the supplied public key");

  // Re-hash the bytes in hand. The manifest says which probe was authorized;
  // this is what checks the probe we are holding is that one.
  const actual = sha256(job.probe.source);
  if (![...job.jobSpec.probeHashes].includes(actual)) {
    problems.push("the probe bytes in hand do not hash to a probe the spec authorized");
  }

  // The binding must match what we are about to do, not just be internally
  // consistent: a valid spec for another repository is still not for us.
  if (job.binding.baseSha !== job.baseSha || job.binding.headSha !== job.headSha) {
    problems.push("the job asks for commits the spec did not authorize");
  }
  if (job.binding.policyDigest !== job.policy.digest) {
    problems.push("the job asks for an execution policy the spec did not authorize");
  }

  return problems;
};

/**
 * Run one job. Refuses before executing anything when the instruction does not
 * check out, and refuses to start at all if a secret reached this process,
 * because that means the boundary above it is broken and running would only
 * hide it.
 */
export const runJob = async (job: RunnerJob): Promise<RunnerResult> => {
  const leaked = secretsIn(process.env);
  if (leaked.length > 0) {
    return {
      ok: false,
      problems: [
        `refusing to run: this process was started with ${leaked.length} secret-shaped variable(s) in its environment (${leaked.slice(0, 3).join(", ")}). The caller's isolation is broken`,
      ],
    };
  }

  const problems = await verifyJob(job);
  if (problems.length > 0) return { ok: false, problems };

  const run = await runDifferential({
    repoDir: job.repoDir,
    baseSha: job.baseSha,
    headSha: job.headSha,
    probe: job.probe,
    policy: job.policy,
    ...(job.runsPerSide !== undefined ? { runsPerSide: job.runsPerSide } : {}),
    ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
    ...(job.prepare != null ? { prepare: job.prepare } : {}),
  });
  return { ok: true, problems: [], run };
};

/** Entry point: `node runner-main.js <job.json> <result.json>`. */
const main = async (): Promise<number> => {
  const [jobPath, outPath] = process.argv.slice(2);
  if (jobPath === undefined || outPath === undefined) {
    console.error("usage: runner <job.json> <result.json>");
    return 2;
  }
  const job = JSON.parse(await readFile(jobPath, "utf8")) as RunnerJob;
  const result = await runJob(job);
  await writeFile(outPath, JSON.stringify(result), "utf8");
  if (!result.ok) {
    for (const p of result.problems) console.error(`runner refused: ${p}`);
    return 1;
  }
  return 0;
};

// Only when executed directly, so importing this for a test spawns nothing.
if (process.argv[1]?.includes("runner-main")) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`runner failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
