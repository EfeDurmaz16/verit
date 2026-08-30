import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
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

/* -------------------------------------------------------------------------- */
/* Asymmetric signing, so the runner can check without holding anything.       */
/* -------------------------------------------------------------------------- */

/*
 * The HMAC above needs one secret on both ends, which is fine between the
 * planner and a sink it owns, and wrong for the runner: the runner executes
 * untrusted code, so anything it holds is compromised the moment a probe reads
 * it. A shared signing secret in that process is a signing secret an attacker
 * has.
 *
 * Ed25519 splits it. The planner keeps a private key and never ships it. The
 * runner gets a public key, which is not a secret at all, and can still refuse
 * a spec that was not signed for this exact run.
 */

/** A planner keypair. The private half never leaves the planning side. */
export const generateJobSpecKeypair = (): { publicKey: string; privateKey: string } => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

/** Sign a binding with the planner's private key. */
export const signJobSpecAsymmetric = (b: JobSpecBinding, privateKeyPem: string): JobSpec => {
  const specHash = jobSpecHash(b);
  const key = createPrivateKey(privateKeyPem);
  return {
    specHash,
    signature: sign(null, Buffer.from(specHash, "hex"), key).toString("hex"),
    probeHashes: [...b.probeHashes].sort(),
  };
};

/**
 * Verify a spec with a public key, the binding it is about to be used under,
 * and the probe bytes in hand.
 *
 * This is what the runner calls. It holds no secret to do it, so a probe that
 * reads everything the runner has still learns nothing that would let it forge
 * a spec for another run.
 */
export const verifyJobSpecAsymmetric = (input: {
  readonly spec: JobSpec;
  readonly binding: JobSpecBinding;
  readonly publicKey: string;
  readonly probeSources?: readonly string[];
}): JobSpecVerification => {
  const problems: string[] = [];

  if (input.publicKey === "") {
    return { verified: false, problems: ["no public key available, so the spec cannot be checked"] };
  }

  const expectedHash = jobSpecHash(input.binding);
  if (!sameHex(expectedHash, input.spec.specHash)) {
    problems.push(
      "the spec was signed over a different run: job, repository, pull request, commits, policy or probes do not match",
    );
  }

  let signatureOk = false;
  try {
    signatureOk = verify(
      null,
      Buffer.from(input.spec.specHash, "hex"),
      createPublicKey(input.publicKey),
      Buffer.from(input.spec.signature, "hex"),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) problems.push("the signature does not verify under this public key");

  const authorized = [...input.spec.probeHashes].sort();
  const bound = [...input.binding.probeHashes].sort();
  if (authorized.join(",") !== bound.join(",")) {
    problems.push("the spec authorizes a different set of probes than this run binds");
  }

  if (input.probeSources !== undefined) {
    const actual = input.probeSources.map(sha256).sort();
    if (actual.join(",") !== authorized.join(",")) {
      problems.push("the probe bytes in hand do not hash to the probes the spec authorized");
    }
  }

  return { verified: problems.length === 0, problems };
};
