import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_PATH_TOKEN, type ProbeSpec } from "./differential";
import { type RunnerJob, runDifferentialIsolated } from "./index";

/*
 * The boundary, end to end, with real processes and a real secret.
 *
 * Every other check in this package assumes the boundary holds. These tests are
 * the ones that make it hold: the process that spawns a probe is started
 * without secrets, so a probe reading its parent's environment finds an empty
 * pocket. On Linux that is a real file read; on macOS there is no /proc and the
 * probe says so, which is why the environment tests carry the weight there.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const keys = generateKeyPairSync("ed25519");
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const PRIVATE_KEY = keys.privateKey;

let seed = 0;
const seedRepo = (): { dir: string; base: string; head: string } => {
  const dir = mkdtempSync(join(tmpdir(), "verit-iso-repo-"));
  dirs.push(dir);
  const git = (args: readonly string[]) =>
    execFileSync("git", [...args], { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  // A distinct file per repository. Two repositories seeded in the same second
  // with identical content produce identical commit shas, which would make the
  // replay test pass for the wrong reason.
  seed += 1;
  writeFileSync(join(dir, "seed.txt"), `repo ${seed}\n`);
  writeFileSync(join(dir, "answer.txt"), "42\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "answer.txt"), "43\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "head"]);
  return { dir, base, head: git(["rev-parse", "HEAD"]).trim() };
};

const POLICY = { orchestration: "isolated", isolation: "child process", digest: "iso-1" };

const buildJob = (input: {
  repo: { dir: string; base: string; head: string };
  source: string;
  signWith?: typeof PRIVATE_KEY;
  tamper?: (job: RunnerJob) => RunnerJob;
}): RunnerJob => {
  const probe: ProbeSpec = {
    id: "p1",
    source: input.source,
    origin: "generated",
    kind: "behavioral",
    fileName: "probe.mjs",
    command: process.execPath,
    args: [PROBE_PATH_TOKEN],
  };
  const probeHashes = [sha256(input.source)];
  const binding = {
    jobId: "job-1",
    repo: "EfeDurmaz16/verit",
    pullRequest: "EfeDurmaz16/verit#1",
    baseSha: input.repo.base,
    headSha: input.repo.head,
    policyDigest: POLICY.digest,
    probeHashes,
  };
  const canonical = [
    `job=${binding.jobId}`,
    `repo=${binding.repo}`,
    `pr=${binding.pullRequest}`,
    `base=${binding.baseSha}`,
    `head=${binding.headSha}`,
    `policy=${binding.policyDigest}`,
    `probes=${[...probeHashes].sort().join(",")}`,
  ].join("\n");
  const specHash = sha256(canonical);
  const job: RunnerJob = {
    repoDir: input.repo.dir,
    baseSha: input.repo.base,
    headSha: input.repo.head,
    probe,
    policy: POLICY,
    runsPerSide: 1,
    timeoutMs: 60_000,
    jobSpec: {
      specHash,
      signature: sign(
        null,
        Buffer.from(specHash, "hex"),
        input.signWith ?? PRIVATE_KEY,
      ).toString("hex"),
      probeHashes,
    },
    publicKey: PUBLIC_KEY,
    binding,
  };
  return input.tamper ? input.tamper(job) : job;
};

/** Put real secrets in this process, then see what the probe got. */
const withSecrets = async <T>(f: () => Promise<T>): Promise<T> => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    VERIT_LANE_API_KEY: "sk-or-CANARY-MODEL-KEY",
    GITHUB_TOKEN: "ghs_CANARY_WRITE_TOKEN",
    VERIT_JOB_SPEC_SECRET: "CANARY-SIGNING-SECRET",
    VERIT_TOKEN_DIR: "/tmp/canary-tokens",
    ACME_DEPLOY_TOKEN: "CANARY-CUSTOMER-SECRET",
  });
  try {
    return await f();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
};

describe("the run happens in a process that never held a secret", () => {
  it("measures the change correctly through the boundary", async () => {
    const repo = seedRepo();
    const out = await withSecrets(() =>
      runDifferentialIsolated({
        job: buildJob({
          repo,
          source:
            'import {readFileSync} from "node:fs";' +
            'process.exit(readFileSync("answer.txt","utf8").trim()==="42"?0:1);',
        }),
      }),
    );
    expect(out.problems).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.run?.base.state).toBe("pass");
    expect(out.run?.head.state).toBe("fail");
  }, 120_000);

  it("hands the probe a parent with nothing worth stealing", async () => {
    const repo = seedRepo();
    const loot = join(mkdtempSync(join(tmpdir(), "verit-iso-loot-")), "loot.txt");
    dirs.push(join(loot, ".."));
    // The probe reads everything it can reach about itself and its parent.
    const source = `
import {writeFileSync, readFileSync} from "node:fs";
let parent = "no-proc";
try { parent = readFileSync(\`/proc/\${process.ppid}/environ\`, "utf8"); } catch {}
writeFileSync(${JSON.stringify(loot)}, JSON.stringify({ own: process.env, parent }));
process.exit(0);
`;
    await withSecrets(() => runDifferentialIsolated({ job: buildJob({ repo, source }) }));

    const got = existsSync(loot) ? readFileSync(loot, "utf8") : "";
    expect(got).not.toBe("");
    // its own environment
    expect(got).not.toContain("sk-or-CANARY");
    expect(got).not.toContain("ghs_CANARY");
    expect(got).not.toContain("CANARY-SIGNING-SECRET");
    expect(got).not.toContain("CANARY-CUSTOMER-SECRET");
    // and its parent's, which is the whole reason the runner is a child
    expect(got).not.toContain("CANARY");
  }, 120_000);
});

describe("the runner checks its instruction rather than trusting it", () => {
  const repo = () => seedRepo();
  const src = "process.exit(0);";

  it("refuses a spec signed by somebody else's key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const out = await runDifferentialIsolated({
      job: buildJob({ repo: repo(), source: src, signWith: other }),
    });
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toContain("signature does not verify");
    expect(out.run).toBeUndefined();
  }, 120_000);

  it("refuses when the probe bytes are not the bytes the spec authorized", async () => {
    const out = await runDifferentialIsolated({
      job: buildJob({
        repo: repo(),
        source: src,
        tamper: (j) => ({
          ...j,
          probe: { ...j.probe, source: "process.exit(0); // and one more thing" },
        }),
      }),
    });
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toContain("do not hash to a probe the spec authorized");
  }, 120_000);

  it("refuses a spec replayed against other commits", async () => {
    const a = repo();
    const b = repo();
    const out = await runDifferentialIsolated({
      job: buildJob({
        repo: a,
        source: src,
        tamper: (j) => ({ ...j, repoDir: b.dir, baseSha: b.base, headSha: b.head }),
      }),
    });
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toContain("commits the spec did not authorize");
  }, 120_000);

  it("refuses an execution policy the spec did not authorize", async () => {
    const out = await runDifferentialIsolated({
      job: buildJob({
        repo: repo(),
        source: src,
        tamper: (j) => ({ ...j, policy: { ...j.policy, digest: "somebody-elses-policy" } }),
      }),
    });
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toContain("policy the spec did not authorize");
  }, 120_000);

  it("refuses before executing anything, so a bad instruction costs nothing", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "verit-iso-marker-")), "ran.txt");
    dirs.push(join(marker, ".."));
    const other = generateKeyPairSync("ed25519").privateKey;
    await runDifferentialIsolated({
      job: buildJob({
        repo: repo(),
        source: `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(0);`,
        signWith: other,
      }),
    });
    expect(existsSync(marker)).toBe(false);
  }, 120_000);
});
