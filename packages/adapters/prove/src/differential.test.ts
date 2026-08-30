import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyResult } from "@verit/domain";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_PATH_TOKEN, type ProbeSpec, probeHash, runDifferential } from "./differential";

/*
 * These run real git and real subprocesses on purpose. The whole claim of this
 * module is that two commits were measured under the same conditions, and a
 * mocked spawn would prove nothing about that.
 */

const policy = {
  orchestration: "two worktrees, same argv, repeats per side",
  isolation: "local test",
  digest: "test-policy-v1",
};

const created: string[] = [];

const git = (args: readonly string[], cwd: string) =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" });

/** A repository with a base commit and a head commit, seeded by the caller. */
const seedRepo = (seed: {
  base: Record<string, string>;
  head: Record<string, string>;
}): { dir: string; baseSha: string; headSha: string } => {
  const dir = mkdtempSync(join(tmpdir(), "verit-diff-repo-"));
  created.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  for (const [name, body] of Object.entries(seed.base)) writeFileSync(join(dir, name), body);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "base"], dir);
  const baseSha = git(["rev-parse", "HEAD"], dir).trim();
  for (const [name, body] of Object.entries(seed.head)) writeFileSync(join(dir, name), body);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "head"], dir);
  const headSha = git(["rev-parse", "HEAD"], dir).trim();
  return { dir, baseSha, headSha };
};

/** A probe that runs node against a file held outside both checkouts. */
const nodeProbe = (source: string, over: Partial<ProbeSpec> = {}): ProbeSpec => ({
  id: "p1",
  source,
  origin: "generated",
  kind: "behavioral",
  fileName: "probe.mjs",
  command: process.execPath,
  args: [PROBE_PATH_TOKEN],
  ...over,
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runDifferential", () => {
  it("reports a regression when the behavior passed on base and fails on head", async () => {
    const repo = seedRepo({
      base: { "answer.txt": "42\n" },
      head: { "answer.txt": "43\n" },
    });
    // The probe reads the repository under test through its own cwd, which is
    // that side's worktree. It never lives inside either checkout.
    const probe = nodeProbe(
      'import {readFileSync} from "node:fs";' +
        'process.exit(readFileSync("answer.txt","utf8").trim()==="42"?0:1);',
    );

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
    });

    expect(run.base.state).toBe("pass");
    expect(run.head.state).toBe("fail");
    expect(classifyResult({ base: run.base, head: run.head }).classification).toBe("regression");
    expect(run.probeHeldOutside).toBe(true);
  }, 60_000);

  it("reports a confirmed fix in the other direction", async () => {
    const repo = seedRepo({
      base: { "answer.txt": "wrong\n" },
      head: { "answer.txt": "42\n" },
    });
    const probe = nodeProbe(
      'import {readFileSync} from "node:fs";' +
        'process.exit(readFileSync("answer.txt","utf8").trim()==="42"?0:1);',
    );

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
    });

    expect(classifyResult({ base: run.base, head: run.head }).classification).toBe("fix-confirmed");
  }, 60_000);

  it("runs each side in its own worktree, so head never inherits base state", async () => {
    // The probe writes a marker on whichever side runs first. If the two sides
    // shared a directory, the second side would see it and pass.
    const repo = seedRepo({ base: { "keep.txt": "x\n" }, head: { "keep.txt": "y\n" } });
    const probe = nodeProbe(
      'import {existsSync,writeFileSync} from "node:fs";' +
        'if (existsSync("marker.tmp")) process.exit(1);' +
        'writeFileSync("marker.tmp","1");' +
        "process.exit(0);",
      { id: "p-isolation" },
    );

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 1,
    });

    expect(run.base.state).toBe("pass");
    expect(run.head.state).toBe("pass");
    expect(classifyResult({ base: run.base, head: run.head }).classification).toBe(
      "no-differential",
    );
  }, 60_000);

  it("refuses to call it held outside when a side rewrites the probe", async () => {
    const repo = seedRepo({ base: { "a.txt": "1\n" }, head: { "a.txt": "2\n" } });
    // A hostile probe target: the code under test overwrites the probe file it
    // was handed. The bytes that ran on head are not the bytes that ran on base.
    const probe = nodeProbe(
      'import {writeFileSync} from "node:fs";' +
        "writeFileSync(process.argv[1], 'process.exit(0)');" +
        "process.exit(0);",
      { id: "p-tamper" },
    );

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 1,
    });

    expect(run.probeHeldOutside).toBe(false);
    expect(run.observedProbeHashes.base).not.toBe(probeHash(probe));
  }, 60_000);

  it("runs the canonical probe on both sides even when the repo ships its own differing version", async () => {
    // The classic way a change makes itself look good: it edits the test. Base
    // and head each carry their own check.js, and neither is what runs. The
    // probe installed from custody is identical on both sides, so the
    // comparison is about the code, not about the test the branch shipped.
    const repo = seedRepo({
      base: { "check.js": "process.exit(0);\n", "answer.txt": "42\n" },
      head: { "check.js": "process.exit(0);\n", "answer.txt": "43\n" },
    });
    const canonical =
      'import {readFileSync} from "node:fs";' +
      'process.exit(readFileSync("answer.txt","utf8").trim()==="42"?0:1);';
    const probe = nodeProbe(canonical, {
      id: "p-install",
      fileName: "check.js",
      installPath: "check.js",
    });

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 1,
    });

    // The repo's own check.js would have exited 0 on both sides. The canonical
    // probe does not, which is how we know ours ran.
    expect(run.base.state).toBe("pass");
    expect(run.head.state).toBe("fail");
    expect(classifyResult({ base: run.base, head: run.head }).classification).toBe("regression");
    expect(run.probeHeldOutside).toBe(true);
  }, 60_000);

  it("calls a missing runner incompatible, never a behavioral failure", async () => {
    const repo = seedRepo({ base: { "a.txt": "1\n" }, head: { "a.txt": "2\n" } });
    const probe = nodeProbe("process.exit(0);", {
      id: "p-missing",
      command: "definitely-not-a-real-binary-verit",
      args: [PROBE_PATH_TOKEN],
    });

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 1,
    });

    expect(run.base.state).toBe("incompatible");
    expect(run.head.state).toBe("incompatible");
    const out = classifyResult({ base: run.base, head: run.head });
    expect(out.classification).toBe("inconclusive");
    expect(out.inconclusiveReason).toContain("incompatible");
  }, 60_000);

  it("calls a side unstable when its repeats disagree", async () => {
    const repo = seedRepo({ base: { "a.txt": "1\n" }, head: { "a.txt": "2\n" } });
    // Passes the first run in a worktree, fails the second: exactly the shape
    // of a flaky test, which must never be read as a caused failure.
    const probe = nodeProbe(
      'import {existsSync,writeFileSync} from "node:fs";' +
        'if (existsSync("ran.tmp")) process.exit(1);' +
        'writeFileSync("ran.tmp","1");' +
        "process.exit(0);",
      { id: "p-flaky" },
    );

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 2,
    });

    expect(run.base.state).toBe("unstable");
    expect(run.base.observedStates).toEqual(["pass", "fail"]);
    const out = classifyResult({ base: run.base, head: run.head });
    expect(out.classification).toBe("inconclusive");
    expect(out.inconclusiveReason).toContain("unstable");
  }, 60_000);

  it("records each side's resolved dependencies separately when the PR changes them", async () => {
    const repo = seedRepo({
      base: { "package.json": '{"name":"x","version":"1.0.0"}\n', "a.txt": "1\n" },
      head: { "package.json": '{"name":"x","version":"2.0.0"}\n', "a.txt": "1\n" },
    });
    const probe = nodeProbe("process.exit(0);", { id: "p-deps" });

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 1,
    });

    const [base, head] = run.sides;
    expect(base.side).toBe("base");
    expect(head.side).toBe("head");
    // The difference is evidence, not a reason to refuse the comparison.
    expect(base.resolvedDependencies).not.toBe(head.resolvedDependencies);
    expect(base.environmentDigest).not.toBe(head.environmentDigest);
    expect(run.base.state).toBe("pass");
    expect(run.head.state).toBe("pass");
  }, 60_000);

  it("treats a failed preparation as an execution error, not a failing suite", async () => {
    const repo = seedRepo({ base: { "a.txt": "1\n" }, head: { "a.txt": "2\n" } });
    const probe = nodeProbe("process.exit(0);", { id: "p-prep" });

    const run = await runDifferential({
      repoDir: repo.dir,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      probe,
      policy,
      runsPerSide: 1,
      prepare: { command: process.execPath, args: ["-e", "process.exit(3)"], source: "install" },
    });

    expect(run.base.state).toBe("execution-error");
    expect(run.head.state).toBe("execution-error");
    expect(classifyResult({ base: run.base, head: run.head }).classification).toBe("inconclusive");
  }, 60_000);
});
