import { describe, expect, it } from "vitest";
import {
  type JobSpecBinding,
  canonicalBinding,
  jobSpecHash,
  probeSourceHash,
  signJobSpec,
  verifyJobSpec,
} from "./jobspec";

/*
 * The spec is the whole trust boundary between the plane that plans a run and
 * the compute that executes it. These tests try to move a valid spec somewhere
 * it was not meant for, which is the only attack that matters here.
 */

const SECRET = "a-secret-that-lives-only-in-the-planning-plane";

const binding = (over: Partial<JobSpecBinding> = {}): JobSpecBinding => ({
  jobId: "job-1",
  repo: "EfeDurmaz16/verit",
  pullRequest: "EfeDurmaz16/verit#10",
  baseSha: "aaaaaaaaaaaaaaaa",
  headSha: "bbbbbbbbbbbbbbbb",
  policyDigest: "policy-v1",
  probeHashes: [probeSourceHash("process.exit(0)")],
  ...over,
});

const verify = (b: JobSpecBinding, spec = signJobSpec(binding(), SECRET)) =>
  verifyJobSpec({ spec, binding: b, secret: SECRET });

describe("a spec verifies only under the run it was signed for", () => {
  it("verifies against its own binding", () => {
    expect(verify(binding()).verified).toBe(true);
  });

  const moved: Array<[string, Partial<JobSpecBinding>]> = [
    ["another job", { jobId: "job-2" }],
    ["another repository", { repo: "someone/else" }],
    ["another pull request", { pullRequest: "EfeDurmaz16/verit#99" }],
    ["another base commit", { baseSha: "cccccccccccccccc" }],
    ["another head commit", { headSha: "dddddddddddddddd" }],
    ["another execution policy", { policyDigest: "policy-v2" }],
  ];
  for (const [what, change] of moved) {
    it(`refuses when replayed against ${what}`, () => {
      const out = verify(binding(change));
      expect(out.verified).toBe(false);
      expect(out.problems.join(" ")).toContain("signed over a different run");
    });
  }

  it("refuses when the probe set changes", () => {
    const out = verify(binding({ probeHashes: [probeSourceHash("process.exit(1)")] }));
    expect(out.verified).toBe(false);
  });
});

describe("the signature is what makes the spec unforgeable", () => {
  it("refuses a spec signed with a different secret", () => {
    const forged = signJobSpec(binding(), "a-secret-the-attacker-picked");
    expect(verifyJobSpec({ spec: forged, binding: binding(), secret: SECRET }).verified).toBe(false);
  });

  it("refuses a tampered signature", () => {
    const spec = signJobSpec(binding(), SECRET);
    const out = verifyJobSpec({
      spec: { ...spec, signature: `${spec.signature.slice(0, -1)}0` },
      binding: binding(),
      secret: SECRET,
    });
    expect(out.verified).toBe(false);
    expect(out.problems.join(" ")).toContain("signature does not verify");
  });

  it("refuses a spec whose hash was swapped for another valid binding's hash", () => {
    const other = jobSpecHash(binding({ pullRequest: "EfeDurmaz16/verit#99" }));
    const spec = signJobSpec(binding(), SECRET);
    const out = verifyJobSpec({
      spec: { ...spec, specHash: other },
      binding: binding(),
      secret: SECRET,
    });
    expect(out.verified).toBe(false);
  });

  it("fails closed with no secret rather than skipping the check", () => {
    const out = verifyJobSpec({
      spec: signJobSpec(binding(), SECRET),
      binding: binding(),
      secret: "",
    });
    expect(out.verified).toBe(false);
    expect(out.problems.join(" ")).toContain("cannot be checked");
  });

  it("refuses garbage in the signature field without throwing", () => {
    const spec = signJobSpec(binding(), SECRET);
    for (const signature of ["", "not-hex", "zz"]) {
      expect(
        verifyJobSpec({ spec: { ...spec, signature }, binding: binding(), secret: SECRET }).verified,
      ).toBe(false);
    }
  });
});

describe("the probe bytes in hand are re-hashed, not trusted", () => {
  it("accepts the sources the spec authorized", () => {
    const out = verifyJobSpec({
      spec: signJobSpec(binding(), SECRET),
      binding: binding(),
      secret: SECRET,
      probeSources: ["process.exit(0)"],
    });
    expect(out.verified).toBe(true);
  });

  it("refuses a probe whose bytes were swapped after signing", () => {
    const out = verifyJobSpec({
      spec: signJobSpec(binding(), SECRET),
      binding: binding(),
      secret: SECRET,
      probeSources: ["process.exit(0) // and also do something else"],
    });
    expect(out.verified).toBe(false);
    expect(out.problems.join(" ")).toContain("do not hash to the probes the spec authorized");
  });

  it("refuses an extra probe smuggled alongside an authorized one", () => {
    const out = verifyJobSpec({
      spec: signJobSpec(binding(), SECRET),
      binding: binding(),
      secret: SECRET,
      probeSources: ["process.exit(0)", "curl evil.example"],
    });
    expect(out.verified).toBe(false);
  });
});

describe("the binding hashes canonically", () => {
  it("does not depend on the order the probe hashes arrived in", () => {
    const a = jobSpecHash(binding({ probeHashes: ["aa", "bb"] }));
    const b = jobSpecHash(binding({ probeHashes: ["bb", "aa"] }));
    expect(a).toBe(b);
  });

  it("keeps fields apart, so two of them cannot run together into a third", () => {
    const a = jobSpecHash(binding({ repo: "a/b", pullRequest: "c/d#1" }));
    const b = jobSpecHash(binding({ repo: "a/b\npr=c/d#1", pullRequest: "" }));
    expect(a).not.toBe(b);
  });

  it("names every bound field in the canonical form", () => {
    const text = canonicalBinding(binding());
    for (const key of ["job=", "repo=", "pr=", "base=", "head=", "policy=", "probes="]) {
      expect(text).toContain(key);
    }
  });
});
