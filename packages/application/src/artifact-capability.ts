import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * How the execution job gets its artifacts out without holding a credential.
 *
 * The job runs untrusted code. It must be able to hand back logs and outputs,
 * and it must not be able to do anything else, so it is given a capability
 * rather than a token: one write, of one named artifact, for one run, expiring
 * in minutes.
 *
 * The design assumes the capability is stolen. Everything about it is chosen so
 * that the attacker who steals it can do exactly what the job could already do,
 * which is upload this run's own artifact once. There is no read, no list, no
 * second use, and nothing outside this job's own key. That is the blast radius,
 * and it is the point.
 */

/** What a capability may do. There is deliberately only one verb. */
export const ARTIFACT_WRITE = "artifact-write" as const;

export interface CapabilityClaims {
  readonly purpose: typeof ARTIFACT_WRITE;
  readonly jobId: string;
  readonly repo: string;
  readonly pullRequest: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** The exact object key this capability may write, and nothing else. */
  readonly artifactKey: string;
  /** sha256 of the bytes it may write. A different body does not verify. */
  readonly artifactHash: string;
  /** One use. The verifier consumes it and a replay finds it gone. */
  readonly nonce: string;
  /** Epoch millis. Minutes, not hours: the job uploads and is done. */
  readonly expiresAtMs: number;
}

export interface ArtifactCapability {
  readonly claims: CapabilityClaims;
  readonly signature: string;
}

/** Default life. Long enough for a slow upload, short enough to be useless later. */
export const DEFAULT_CAPABILITY_TTL_MS = 10 * 60_000;

const canonical = (c: CapabilityClaims): string =>
  [
    `purpose=${c.purpose}`,
    `job=${c.jobId}`,
    `repo=${c.repo}`,
    `pr=${c.pullRequest}`,
    `base=${c.baseSha}`,
    `head=${c.headSha}`,
    `key=${c.artifactKey}`,
    `hash=${c.artifactHash}`,
    `nonce=${c.nonce}`,
    `exp=${c.expiresAtMs}`,
  ].join("\n");

const sign = (c: CapabilityClaims, secret: string): string =>
  createHmac("sha256", secret).update(canonical(c)).digest("hex");

const sameHex = (a: string, b: string): boolean => {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
};

/**
 * Mint a capability for one artifact of one run.
 *
 * The nonce is supplied rather than generated here so the caller owns both
 * sides of single use: it records the nonce as unspent when it mints, and the
 * verifier spends it. A minting function that invented its own nonce would
 * leave nobody responsible for remembering it.
 */
export const mintArtifactCapability = (input: {
  readonly claims: Omit<CapabilityClaims, "purpose" | "expiresAtMs"> & { expiresAtMs?: number };
  readonly secret: string;
  readonly nowMs: number;
  readonly ttlMs?: number;
}): ArtifactCapability => {
  const claims: CapabilityClaims = {
    purpose: ARTIFACT_WRITE,
    jobId: input.claims.jobId,
    repo: input.claims.repo,
    pullRequest: input.claims.pullRequest,
    baseSha: input.claims.baseSha,
    headSha: input.claims.headSha,
    artifactKey: input.claims.artifactKey,
    artifactHash: input.claims.artifactHash,
    nonce: input.claims.nonce,
    expiresAtMs: input.claims.expiresAtMs ?? input.nowMs + (input.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS),
  };
  return { claims, signature: sign(claims, input.secret) };
};

export interface CapabilityCheck {
  readonly allowed: boolean;
  readonly problems: readonly string[];
}

/**
 * Decide whether one upload may happen.
 *
 * Everything is checked against the write actually being attempted, not against
 * what the capability says about itself: the key being written, the bytes being
 * written, the clock, and whether this nonce was already spent. `spendNonce`
 * returns false when it has been, which is what makes the capability single
 * use; it is called last so a rejected request does not burn the nonce.
 */
export const authorizeArtifactWrite = (input: {
  readonly capability: ArtifactCapability;
  readonly secret: string;
  readonly nowMs: number;
  /** What the job is actually trying to write. */
  readonly attempt: { readonly artifactKey: string; readonly artifactHash: string };
  /** Marks the nonce spent. False when it was already spent. */
  readonly spendNonce: (nonce: string) => boolean;
}): CapabilityCheck => {
  const problems: string[] = [];
  const { capability: cap, secret } = input;

  if (secret === "") {
    return { allowed: false, problems: ["no signing secret, so the capability cannot be checked"] };
  }
  if (cap.claims.purpose !== ARTIFACT_WRITE) {
    problems.push("the capability is not an artifact write");
  }
  if (!sameHex(sign(cap.claims, secret), cap.signature)) {
    problems.push("the capability does not verify under this secret");
  }
  if (input.nowMs >= cap.claims.expiresAtMs) {
    problems.push("the capability has expired");
  }
  if (cap.claims.artifactKey !== input.attempt.artifactKey) {
    problems.push("the write targets a different artifact than the capability names");
  }
  if (cap.claims.artifactHash !== input.attempt.artifactHash) {
    problems.push("the bytes being written are not the bytes the capability authorized");
  }

  if (problems.length > 0) return { allowed: false, problems };

  // Last, so a rejected attempt cannot burn a capability the job still needs.
  if (!input.spendNonce(cap.claims.nonce)) {
    return { allowed: false, problems: ["this capability was already used"] };
  }
  return { allowed: true, problems: [] };
};

/**
 * Somewhere to remember spent nonces. In memory here because the execution
 * plane is short lived; a hosted sink swaps this for a row with a TTL.
 */
export const makeNonceLedger = (): {
  issue: (nonce: string) => void;
  spend: (nonce: string) => boolean;
  outstanding: () => number;
} => {
  const unspent = new Set<string>();
  return {
    issue: (nonce) => {
      unspent.add(nonce);
    },
    spend: (nonce) => unspent.delete(nonce),
    outstanding: () => unspent.size,
  };
};
