import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ArtifactCapability,
  DEFAULT_CAPABILITY_TTL_MS,
  authorizeArtifactWrite,
  makeNonceLedger,
  mintArtifactCapability,
} from "./artifact-capability";

/*
 * These tests are written from the attacker's side.
 *
 * The execution job runs untrusted code, so the capability it holds should be
 * assumed stolen. What matters is not that it cannot leak, it is that holding
 * it buys nothing beyond the one upload the job was already going to make.
 */

const SECRET = "sink-secret";
const NOW = 1_700_000_000_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const BODY = "run logs";
const HASH = sha256(BODY);

const mint = (over: Partial<Parameters<typeof mintArtifactCapability>[0]["claims"]> = {}) => {
  const ledger = makeNonceLedger();
  const nonce = over.nonce ?? "nonce-1";
  ledger.issue(nonce);
  const capability = mintArtifactCapability({
    claims: {
      jobId: "job-1",
      repo: "EfeDurmaz16/verit",
      pullRequest: "EfeDurmaz16/verit#10",
      baseSha: "aaaa",
      headSha: "bbbb",
      artifactKey: "runs/job-1/logs.txt",
      artifactHash: HASH,
      ...over,
      nonce,
    },
    secret: SECRET,
    nowMs: NOW,
  });
  return { capability, ledger };
};

const authorize = (
  capability: ArtifactCapability,
  ledger: ReturnType<typeof makeNonceLedger>,
  over: {
    nowMs?: number;
    artifactKey?: string;
    artifactHash?: string;
    secret?: string;
  } = {},
) =>
  authorizeArtifactWrite({
    capability,
    secret: over.secret ?? SECRET,
    nowMs: over.nowMs ?? NOW + 1_000,
    attempt: {
      artifactKey: over.artifactKey ?? capability.claims.artifactKey,
      artifactHash: over.artifactHash ?? capability.claims.artifactHash,
    },
    spendNonce: ledger.spend,
  });

describe("the capability allows exactly one upload", () => {
  it("allows the write it was minted for", () => {
    const { capability, ledger } = mint();
    expect(authorize(capability, ledger).allowed).toBe(true);
  });

  it("refuses the same capability a second time", () => {
    const { capability, ledger } = mint();
    expect(authorize(capability, ledger).allowed).toBe(true);
    const replay = authorize(capability, ledger);
    expect(replay.allowed).toBe(false);
    expect(replay.problems.join(" ")).toContain("already used");
  });

  it("does not burn the nonce on a request it rejected", () => {
    const { capability, ledger } = mint();
    // a wrong body first: this must not consume the single use
    expect(authorize(capability, ledger, { artifactHash: sha256("something else") }).allowed).toBe(
      false,
    );
    expect(ledger.outstanding()).toBe(1);
    expect(authorize(capability, ledger).allowed).toBe(true);
  });

  it("expires in minutes, not hours", () => {
    const { capability, ledger } = mint();
    expect(capability.claims.expiresAtMs).toBe(NOW + DEFAULT_CAPABILITY_TTL_MS);
    const late = authorize(capability, ledger, { nowMs: capability.claims.expiresAtMs });
    expect(late.allowed).toBe(false);
    expect(late.problems.join(" ")).toContain("expired");
  });
});

describe("a stolen capability buys nothing else", () => {
  it("cannot write a different artifact", () => {
    const { capability, ledger } = mint();
    const out = authorize(capability, ledger, { artifactKey: "runs/other-job/secrets.txt" });
    expect(out.allowed).toBe(false);
    expect(out.problems.join(" ")).toContain("different artifact");
  });

  it("cannot write different bytes under the authorized key", () => {
    const { capability, ledger } = mint();
    const out = authorize(capability, ledger, { artifactHash: sha256("exfiltrated env") });
    expect(out.allowed).toBe(false);
    expect(out.problems.join(" ")).toContain("not the bytes the capability authorized");
  });

  it("cannot be edited to point somewhere else, because the signature covers it", () => {
    const { capability, ledger } = mint();
    const edited: ArtifactCapability = {
      ...capability,
      claims: { ...capability.claims, artifactKey: "runs/other-job/logs.txt" },
    };
    const out = authorizeArtifactWrite({
      capability: edited,
      secret: SECRET,
      nowMs: NOW + 1_000,
      attempt: { artifactKey: "runs/other-job/logs.txt", artifactHash: HASH },
      spendNonce: ledger.spend,
    });
    expect(out.allowed).toBe(false);
    expect(out.problems.join(" ")).toContain("does not verify");
  });

  it("cannot have its expiry pushed out", () => {
    const { capability, ledger } = mint();
    const edited: ArtifactCapability = {
      ...capability,
      claims: { ...capability.claims, expiresAtMs: NOW + 86_400_000 },
    };
    expect(
      authorizeArtifactWrite({
        capability: edited,
        secret: SECRET,
        nowMs: NOW + 3_600_000,
        attempt: { artifactKey: edited.claims.artifactKey, artifactHash: HASH },
        spendNonce: ledger.spend,
      }).allowed,
    ).toBe(false);
  });

  it("is useless against a sink holding a different secret", () => {
    const { capability, ledger } = mint();
    expect(authorize(capability, ledger, { secret: "another-sink" }).allowed).toBe(false);
  });

  it("carries no read or list verb at all", () => {
    const { capability } = mint();
    expect(capability.claims.purpose).toBe("artifact-write");
    expect(Object.values(capability.claims)).not.toContain("read");
  });
});

describe("the sink fails closed", () => {
  it("refuses when it has no secret rather than skipping the check", () => {
    const { capability, ledger } = mint();
    const out = authorize(capability, ledger, { secret: "" });
    expect(out.allowed).toBe(false);
    expect(out.problems.join(" ")).toContain("cannot be checked");
    expect(ledger.outstanding()).toBe(1);
  });

  it("refuses a capability whose signature is garbage without throwing", () => {
    const { capability, ledger } = mint();
    for (const signature of ["", "not-hex", "00"]) {
      expect(authorize({ ...capability, signature }, ledger).allowed).toBe(false);
    }
  });

  it("refuses a nonce the ledger never issued", () => {
    const { capability } = mint();
    const empty = makeNonceLedger();
    expect(authorize(capability, empty).allowed).toBe(false);
  });
});
