import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Isolation for the lane tools. The lane's bash tool runs model-chosen
 * commands; without isolation it runs them in the same checkout prove is about
 * to measure, so a model could delete a failing test, rewrite the test script,
 * or `git checkout` a passing ref and hand prove a green tree nobody earned.
 * openLaneCheckout gives the tools their own checkout of HEAD instead. The
 * prove workspace never changes, so the dirty-tree guard on the prove side
 * stays quiet on a well-behaved run and only fires on a real escape.
 */

const GIT_TIMEOUT_MS = 60_000;
const GIT_BUFFER = 8 * 1024 * 1024;

const git = (args: readonly string[], cwd: string) =>
  spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_BUFFER,
  });

export interface LaneCheckout {
  /** Where the lane tools run. */
  readonly root: string;
  /** True for a separate checkout, false when it fell back to the source tree. */
  readonly isolated: boolean;
  /** Remove the temp checkout. Call once, in a finally. */
  readonly cleanup: () => void;
}

const noop = (): void => {};

/**
 * An isolated checkout of `source` at HEAD.
 *
 * A git worktree first: it shares the object store and costs almost nothing,
 * and it never touches the source working tree. If worktree add fails, a
 * tarball of the tracked tree at HEAD, extracted into a temp dir. If neither
 * works (no git, no commit), the lane runs in `source` itself; the prove
 * dirty-tree guard is then the remaining net, turning any mutation neutral
 * rather than green. Creating and removing a worktree leaves the source HEAD
 * and `git status` untouched, so a clean run does not trip that guard.
 */
export const openLaneCheckout = (source: string): LaneCheckout => {
  const base = mkdtempSync(join(tmpdir(), "verit-lane-checkout-"));
  const root = join(base, "tree");
  const wipe = () => rmSync(base, { recursive: true, force: true });

  // worktree: cheapest, shares objects. Detached so it never locks a branch.
  const wt = git(["worktree", "add", "--detach", root, "HEAD"], source);
  if (wt.status === 0) {
    return {
      root,
      isolated: true,
      cleanup: () => {
        git(["worktree", "remove", "--force", root], source);
        wipe();
      },
    };
  }

  // fallback: export the tracked tree at HEAD into the temp dir.
  const tar = join(base, "tree.tar");
  const archive = git(["archive", "--format=tar", "-o", tar, "HEAD"], source);
  if (archive.status === 0) {
    mkdirSync(root);
    const extract = spawnSync("tar", ["-xf", tar, "-C", root], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_BUFFER,
    });
    if (extract.status === 0) {
      return { root, isolated: true, cleanup: wipe };
    }
  }

  // no isolation possible: run in place and lean on the prove guard.
  wipe();
  return { root: source, isolated: false, cleanup: noop };
};
