import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { proofVerdict } from "@verit/domain";
import { gitState, makeProveRunner } from "@verit/adapter-prove";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLaneCheckout } from "./checkout";
import { executeLaneTool } from "./tools";

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
};

/*
 * The blocker: lane tools ran in the very checkout prove was about to measure,
 * so a model told to `rm` the failing test, rewrite the test script, and
 * `git checkout` a passing ref could hand prove a green tree it never earned.
 * The fixture drives exactly that hostile input and proves the prove workspace
 * is byte-unchanged, because the tools ran in an isolated checkout of HEAD.
 */

const git = (args: readonly string[], cwd: string) =>
  spawnSync("git", [...args], { cwd, encoding: "utf8" });

const headSha = (dir: string) => git(["rev-parse", "HEAD"], dir).stdout.trim();
const porcelain = (dir: string) => git(["status", "--porcelain"], dir).stdout;

let source: string;

beforeAll(() => {
  source = mkdtempSync(join(tmpdir(), "verit-prove-tree-"));
  git(["init", "-q", "-b", "main"], source);
  git(["config", "user.email", "t@example.com"], source);
  git(["config", "user.name", "t"], source);
  writeFileSync(join(source, "failing.test.ts"), "expect(1).toBe(2);\n");
  writeFileSync(join(source, "run-tests.sh"), "vitest run\n");
  git(["add", "-A"], source);
  git(["commit", "-qm", "seed"], source);
  // a second ref the hostile command can try to swap onto
  git(["branch", "other"], source);
});

afterAll(() => {
  rmSync(source, { recursive: true, force: true });
});

describe("openLaneCheckout", () => {
  it("isolates hostile lane tool writes from the prove workspace", () => {
    const beforeHead = headSha(source);
    const beforeFailing = readFileSync(join(source, "failing.test.ts"), "utf8");
    const beforeScript = readFileSync(join(source, "run-tests.sh"), "utf8");
    expect(porcelain(source)).toBe("");

    const checkout = openLaneCheckout(source);
    try {
      expect(checkout.isolated).toBe(true);
      expect(checkout.root).not.toBe(source);

      // exactly the hostile input from the audit, run through the real tool.
      const r = executeLaneTool(checkout.root, "bash", {
        command:
          "rm -f failing.test.ts && printf 'echo pass\\n' > run-tests.sh && git checkout other",
      });
      expect(r.isError).toBe(false);

      // the mutation really happened, in the isolated checkout only.
      expect(existsSync(join(checkout.root, "failing.test.ts"))).toBe(false);
    } finally {
      checkout.cleanup();
    }

    // the prove workspace is byte-unchanged: same HEAD, clean tree, same files.
    expect(headSha(source)).toBe(beforeHead);
    expect(porcelain(source)).toBe("");
    expect(readFileSync(join(source, "failing.test.ts"), "utf8")).toBe(beforeFailing);
    expect(readFileSync(join(source, "run-tests.sh"), "utf8")).toBe(beforeScript);
    // and the temp checkout is gone after cleanup.
    expect(existsSync(checkout.root)).toBe(false);
  });

  // bash is bash: it can cd out of the isolated checkout to the prove workspace
  // it discovers behind the worktree, and hide the edit from git status with a
  // skip-worktree bit so HEAD and porcelain look unmoved. The write is not
  // impossible, so the guarantee rests on the guard: prove, holding the
  // pre-lane snapshot, must still refuse. This is the whole chain through the
  // real tool and the real prove runner.
  it("turns prove neutral even when a lane bash escape hides its own doctoring", async () => {
    const src = mkdtempSync(join(tmpdir(), "verit-escape-src-"));
    git(["init", "-q", "-b", "main"], src);
    git(["config", "user.email", "t@example.com"], src);
    git(["config", "user.name", "t"], src);
    // a github origin so the prove repo-guard lets it run at all
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], src);
    writeFileSync(join(src, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    // the suite fails while expected.txt reads "2", passes once doctored to "1"
    writeFileSync(
      join(src, "check.js"),
      'const fs=require("fs");process.exit(fs.readFileSync("expected.txt","utf8").trim()==="2"?1:0);\n',
    );
    writeFileSync(join(src, "expected.txt"), "2\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "seed"], src);

    // the pipeline snapshots the prove workspace before the lane runs
    const baseline = await gitState(src);
    expect(baseline).not.toBeNull();

    const checkout = openLaneCheckout(src);
    expect(checkout.isolated).toBe(true);
    try {
      // real hostile bash: find the source repo behind the worktree, cd in,
      // set skip-worktree so status goes blind, then doctor the file to pass.
      const attack =
        'SRC=$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)"); ' +
        'cd "$SRC" && git update-index --skip-worktree expected.txt && printf "1\\n" > expected.txt';
      const r = executeLaneTool(checkout.root, "bash", { command: attack });
      expect(r.isError).toBe(false); // the escape itself succeeds
    } finally {
      checkout.cleanup();
    }

    // the doctoring really reached the prove workspace and porcelain is blind
    expect(readFileSync(join(src, "expected.txt"), "utf8").trim()).toBe("1");
    expect(git(["status", "--porcelain"], src).stdout).toBe("");

    // but prove refuses: the folded ls-files hash moved when the bit was set,
    // so the doctored suite never runs to a green.
    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: src, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(proofVerdict(out)).toBe("neutral");
    rmSync(src, { recursive: true, force: true });
  }, 30_000);

  // Same fixture as the skip-worktree case, but the bytes change without
  // flipping HEAD, porcelain, or ls-files -v. A repo-local clean/smudge in
  // .git/info/attributes + filter.* (shared via git-common-dir) rewrites
  // expected.txt on checkout; clean reconstitutes the committed blob so
  // status stays empty. gitState must hash the on-disk bytes prove will
  // run, or this escape is a green.
  it("turns prove neutral when a lane bash doctors expected.txt via repo-local clean/smudge", async () => {
    const src = mkdtempSync(join(tmpdir(), "verit-smudge-src-"));
    git(["init", "-q", "-b", "main"], src);
    git(["config", "user.email", "t@example.com"], src);
    git(["config", "user.name", "t"], src);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], src);
    writeFileSync(join(src, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    writeFileSync(
      join(src, "check.js"),
      'const fs=require("fs");process.exit(fs.readFileSync("expected.txt","utf8").trim()==="2"?1:0);\n',
    );
    writeFileSync(join(src, "expected.txt"), "2\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "seed"], src);

    const beforeHead = headSha(src);
    const baseline = await gitState(src);
    expect(baseline).not.toBeNull();

    const checkout = openLaneCheckout(src);
    expect(checkout.isolated).toBe(true);
    try {
      const attack =
        'SRC=$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)"); ' +
        'mkdir -p "$SRC/.git/info"; ' +
        'printf "expected.txt filter=veritpass\\n" > "$SRC/.git/info/attributes"; ' +
        'git -C "$SRC" config filter.veritpass.clean "echo 2"; ' +
        'git -C "$SRC" config filter.veritpass.smudge "echo 1"; ' +
        'rm -f "$SRC/expected.txt"; ' +
        'git -C "$SRC" checkout HEAD -- expected.txt';
      const r = executeLaneTool(checkout.root, "bash", { command: attack });
      expect(r.isError).toBe(false);
    } finally {
      checkout.cleanup();
    }

    // the attack landed, and every metadata signal the old snapshot trusted
    // still matches the baseline: HEAD, porcelain, ls-files -v.
    expect(readFileSync(join(src, "expected.txt"), "utf8").trim()).toBe("1");
    expect(headSha(src)).toBe(beforeHead);
    expect(git(["status", "--porcelain"], src).stdout).toBe("");
    expect(git(["ls-files", "-v", "--", "expected.txt"], src).stdout).toMatch(/^H expected\.txt/);

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: src, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(out.refused).toBeTruthy();
    expect(out.refused).toContain("working tree changed");
    expect(proofVerdict(out)).toBe("neutral");
    expect(out.log).toBe("");
    rmSync(src, { recursive: true, force: true });
  }, 15_000);

  it("does not go green when a lane worktree plants a git replace for a failing blob", async () => {
    const src = mkdtempSync(join(tmpdir(), "verit-replace-src-"));
    git(["init", "-q", "-b", "main"], src);
    git(["config", "user.email", "t@example.com"], src);
    git(["config", "user.name", "t"], src);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"], src);
    writeFileSync(join(src, "package.json"), JSON.stringify({ scripts: { test: "node check.js" } }));
    writeFileSync(
      join(src, "check.js"),
      'const fs=require("fs");process.exit(fs.readFileSync("failing.js","utf8").includes("must fail")?1:0);\n',
    );
    writeFileSync(join(src, "failing.js"), "must fail\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "seed"], src);

    const beforeHead = headSha(src);
    const beforeFailing = readFileSync(join(src, "failing.js"), "utf8");
    const baseline = await gitState(src);
    expect(baseline).not.toBeNull();

    const checkout = openLaneCheckout(src);
    expect(checkout.isolated).toBe(true);
    try {
      const attack =
        "FAIL=$(git rev-parse HEAD:failing.js); " +
        'PASS=$(printf "pass\\n" | git hash-object -w --stdin); ' +
        'git replace "$FAIL" "$PASS"';
      const r = executeLaneTool(checkout.root, "bash", { command: attack });
      expect(r.isError).toBe(false);
    } finally {
      checkout.cleanup();
    }

    expect(readFileSync(join(src, "failing.js"), "utf8")).toBe(beforeFailing);
    expect(headSha(src)).toBe(beforeHead);
    expect(porcelain(src)).toBe("");
    // the replace is live for ordinary object reads
    expect(git(["cat-file", "blob", "HEAD:failing.js"], src).stdout).toContain("pass");
    expect(git(["--no-replace-objects", "cat-file", "blob", "HEAD:failing.js"], src).stdout).toContain(
      "must fail",
    );

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: src, expectRepo: "EfeDurmaz16/verit", baseline }),
    );
    expect(proofVerdict(out)).not.toBe("success");
    expect(out.refused != null || out.exitCode !== 0).toBe(true);
    rmSync(src, { recursive: true, force: true });
  }, 15_000);

  it("does not expose a persisted http extraheader through lane bash", () => {
    const src = mkdtempSync(join(tmpdir(), "verit-extraheader-src-"));
    git(["init", "-q", "-b", "main"], src);
    git(["config", "user.email", "t@example.com"], src);
    git(["config", "user.name", "t"], src);
    const token = "p02_extraheader_probe_token_7f3a";
    git(["config", "http.https://github.com/.extraheader", `AUTHORIZATION: basic ${token}`], src);
    writeFileSync(join(src, "README.md"), "seed\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "seed"], src);
    expect(git(["config", "--get-regexp", "extraheader"], src).stdout).toContain(token);

    const checkout = openLaneCheckout(src);
    try {
      expect(checkout.isolated).toBe(true);
      const r = executeLaneTool(checkout.root, "bash", {
        command: "git config --list --show-origin; git config --get-regexp extraheader || true",
      });
      expect(r.content).not.toContain(token);
      expect(r.content).not.toContain("AUTHORIZATION: basic");
    } finally {
      checkout.cleanup();
    }

    expect(git(["config", "--get-regexp", "extraheader"], src).stdout).not.toContain(token);
    rmSync(src, { recursive: true, force: true });
  });

  /*
   * clone --shared does not copy extraheader. That path is already closed.
   * This one plants extraheader on the source, puts VERIT_PROVE_CWD in the
   * host exec environ, and reads it the way lane bash does.
   */
  it("does not expose source extraheader via VERIT_PROVE_CWD in the parent environ", () => {
    const src = mkdtempSync(join(tmpdir(), "verit-prove-cwd-extraheader-"));
    git(["init", "-q", "-b", "main"], src);
    git(["config", "user.email", "t@example.com"], src);
    git(["config", "user.name", "t"], src);
    const token = "p02_source_extraheader_via_prove_cwd_7f3a";
    git(["config", "http.https://github.com/.extraheader", `AUTHORIZATION: basic ${token}`], src);
    writeFileSync(join(src, "README.md"), "seed\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "seed"], src);
    expect(git(["config", "--get-regexp", "extraheader"], src).stdout).toContain(token);

    const probe = join(dirname(fileURLToPath(import.meta.url)), "prove-cwd-extraheader-probe.ts");
    const r = spawnSync(process.execPath, ["--import", "tsx", probe, src], {
      cwd: repoRoot(),
      encoding: "utf8",
      env: {
        ...process.env,
        VERIT_PROVE_CWD: src,
        GITHUB_WORKSPACE: src,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain(token);
    expect(r.stdout).not.toContain("AUTHORIZATION: basic");
    const parsed: unknown = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ isError: false });
    rmSync(src, { recursive: true, force: true });
  });
});
