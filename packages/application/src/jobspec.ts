import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JobSpec } from "@verit/domain";

/*
 * The instruction the execution job runs, and what makes it unforgeable.
 *
 * The execution job holds no long-lived credential and does not decide
 * anything. It is handed a spec and it runs what the spec says, so the spec is
 * the whole trust boundary between the plane that plans and the compute that
 * executes.
 *
 * The signature covers a binding, not a payload. Every field that could change
 * the meaning of the run is inside it: which job, which repository, which pull
 * request, which two commits, which execution policy, which exact probe bytes.
 * A spec lifted from one pull request and replayed against another does not
 * verify, because the binding it was signed over is no longer the binding it is
 * being used under.
 *
 * Probe hashes are recomputed from the probe sources at verification time. The
 * spec's list is a claim about which bytes were authorized; the recomputation
 * is what checks the bytes in hand are those bytes.
 */

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Everything that fixes what a run means. Changing any of it changes the hash. */
export interface JobSpecBinding {
  /** The CI job this spec was issued for. */
  readonly jobId: string;
  readonly repo: string;
  /** `owner/repo#number`, so a spec cannot be replayed against another PR. */
  readonly pullRequest: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Digest of the ExecutionPolicy both sides run under. */
  readonly policyDigest: string;
  /** sha256 of every authorized probe's source. Order does not matter. */
  readonly probeHashes: readonly string[];
}

/**
 * Canonical bytes for a binding.
 *
 * Field order is fixed here rather than taken from object key order, and the
 * probe hashes are sorted, so two callers that built the same binding in a
 * different order produce the same hash. The separator cannot appear in a hex
 * digest or a sha, which keeps two fields from being run together into a third
 * meaning.
 */
export const canonicalBinding = (b: JobSpecBinding): string =>
  [
    `job=${b.jobId}`,
    `repo=${b.repo}`,
    `pr=${b.pullRequest}`,
    `base=${b.baseSha}`,
    `head=${b.headSha}`,
    `policy=${b.policyDigest}`,
    `probes=${[...b.probeHashes].sort().join(",")}`,
  ].join("\n");

export const jobSpecHash = (b: JobSpecBinding): string => sha256(canonicalBinding(b));

/** Sign a binding. The secret never leaves the plane that plans the run. */
export const signJobSpec = (b: JobSpecBinding, secret: string): JobSpec => {
  const specHash = jobSpecHash(b);
  return {
    specHash,
    signature: createHmac("sha256", secret).update(specHash).digest("hex"),
    probeHashes: [...b.probeHashes].sort(),
  };
};

/** Constant time compare of two hex strings of any length. */
const sameHex = (a: string, b: string): boolean => {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
};

export interface JobSpecVerification {
  readonly verified: boolean;
  /** Empty when verified. Every reason it failed, in plain words. */
  readonly problems: readonly string[];
}

/**
 * Verify a spec against the binding it is about to be used under, and against
 * the probe bytes actually in hand.
 *
 * Fails closed on every path. A missing secret is a failure, not a skip: a
 * runner that cannot check a signature must not act on it.
 */
export const verifyJobSpec = (input: {
  readonly spec: JobSpec;
  readonly binding: JobSpecBinding;
  readonly secret: string;
  /** The probe sources the runner is holding, to be re-hashed and compared. */
  readonly probeSources?: readonly string[];
}): JobSpecVerification => {
  const problems: string[] = [];

  if (input.secret === "") {
    problems.push("no signing secret available, so the spec cannot be checked");
    return { verified: false, problems };
  }

  const expectedHash = jobSpecHash(input.binding);
  if (!sameHex(expectedHash, input.spec.specHash)) {
    problems.push(
      "the spec was signed over a different run: job, repository, pull request, commits, policy or probes do not match",
    );
  }

  const expectedSig = createHmac("sha256", input.secret).update(input.spec.specHash).digest("hex");
  if (!sameHex(expectedSig, input.spec.signature)) {
    problems.push("the signature does not verify under this secret");
  }

  const authorized = [...input.spec.probeHashes].sort();
  const bound = [...input.binding.probeHashes].sort();
  if (authorized.join(",") !== bound.join(",")) {
    problems.push("the spec authorizes a different set of probes than this run binds");
  }

  if (input.probeSources !== undefined) {
    const actual = input.probeSources.map(sha256).sort();
    if (actual.join(",") !== authorized.join(",")) {
      problems.push(
        "the probe bytes in hand do not hash to the probes the spec authorized",
      );
    }
  }

  return { verified: problems.length === 0, problems };
};

/** Recompute one probe's hash. What the runner checks before it runs anything. */
export const probeSourceHash = (source: string): string => sha256(source);
