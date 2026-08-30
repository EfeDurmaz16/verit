import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proofVerdict } from "@verit/domain";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeProveRunner, privilegedEventRefusal } from "./index";

/*
 * The pwn request guard.
 *
 * prove exists to run a repository's own test command, and on a fork pull
 * request that command is written by whoever opened the pull request. Under a
 * privileged event it would run beside a write-scoped token and the
 * repository's secrets. There is no sandbox that makes that trade worth taking,
 * so prove declines and the Check stays neutral.
 */

describe("privilegedEventRefusal", () => {
  it("refuses the events that carry a write-scoped token", () => {
    for (const event of ["pull_request_target", "workflow_run", "issue_comment"]) {
      const reason = privilegedEventRefusal({ GITHUB_EVENT_NAME: event });
      expect(reason).not.toBeNull();
      expect(reason).toContain(event);
      expect(reason).toContain("on: pull_request");
    }
  });

  it("allows the events verit is meant to run under", () => {
    for (const event of ["pull_request", "push", "schedule", "workflow_dispatch"]) {
      expect(privilegedEventRefusal({ GITHUB_EVENT_NAME: event })).toBeNull();
    }
  });

  it("allows a local run with no event at all", () => {
    expect(privilegedEventRefusal({})).toBeNull();
  });
});

describe("prove declines to execute under a privileged event", () => {
  const dirs: string[] = [];
  const original = process.env.GITHUB_EVENT_NAME;

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    if (original === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = original;
  });

  const repoWithSuite = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "verit-privileged-"));
    dirs.push(dir);
    const git = (args: readonly string[]) =>
      execFileSync("git", [...args], { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    git(["remote", "add", "origin", "https://github.com/EfeDurmaz16/verit.git"]);
    // A suite that would pass loudly, so a missing guard would be visible.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e ''" } }));
    git(["add", "-A"]);
    git(["commit", "-qm", "seed"]);
    return dir;
  };

  it("returns a neutral refusal instead of running the suite", async () => {
    const dir = repoWithSuite();
    process.env.GITHUB_EVENT_NAME = "pull_request_target";

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit" }),
    );

    expect(out.refused).toContain("pull_request_target");
    expect(proofVerdict(out)).toBe("neutral");
    // nothing ran, so there is nothing to report as a pass
    expect(out.log).toBe("");
    expect(out.durationMs).toBe(0);
  }, 30_000);

  it("runs normally under pull_request", async () => {
    const dir = repoWithSuite();
    process.env.GITHUB_EVENT_NAME = "pull_request";

    const out = await Effect.runPromise(
      makeProveRunner().run({ cwd: dir, expectRepo: "EfeDurmaz16/verit" }),
    );

    expect(out.refused ?? "").not.toContain("pull_request_target");
    expect(out.source).not.toBe("privileged event guard");
  }, 30_000);
});
