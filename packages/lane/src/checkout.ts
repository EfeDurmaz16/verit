import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const isCredentialConfigKey = (name: string): boolean => {
  const n = name.toLowerCase();
  if (n === "http.extraheader" || n.endsWith(".extraheader")) return true;
  if (n === "credential.helper") return true;
  return n.startsWith("credential.") && n.endsWith(".helper");
};

/** Drop credential keys from this checkout's local config. Does not touch source. */
const stripLocalCredentialConfig = (repo: string): void => {
  const listed = git(["config", "--local", "--name-only", "--list"], repo);
  if (listed.status !== 0) return;
  for (const line of listed.stdout.split("\n")) {
    const key = line.trim();
    if (key === "" || !isCredentialConfigKey(key)) continue;
    git(["config", "--local", "--unset-all", key], repo);
  }
};

/**
 * An isolated checkout of `source` at HEAD.
 *
 * A shared clone first: it shares the object store, has its own config, and
 * never touches the source working tree. A worktree would inherit the source
 * `http.*.extraheader` / credential helper, and `git config` from lane bash
 * would print the token. If clone fails, a tarball of the tracked tree at
 * HEAD, extracted into a temp dir. If neither works (no git, no commit), the
 * lane runs in `source` itself; the prove dirty-tree guard is then the
 * remaining net, turning any mutation neutral rather than green.
 */
export const openLaneCheckout = (source: string): LaneCheckout => {
  const base = mkdtempSync(join(tmpdir(), "verit-lane-checkout-"));
  const root = join(base, "tree");
  const wipe = () => rmSync(base, { recursive: true, force: true });
  const absSource = resolve(source);

  // shared clone: own config, shared objects. Not a worktree, so a checkout
  // that persisted credentials cannot leak them through git config.
  const cloned = git(["clone", "--shared", "--quiet", absSource, root], absSource);
  if (cloned.status === 0) {
    stripLocalCredentialConfig(root);
    return { root, isolated: true, cleanup: wipe };
  }

  // fallback: export the tracked tree at HEAD into the temp dir.
  rmSync(root, { recursive: true, force: true });
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
