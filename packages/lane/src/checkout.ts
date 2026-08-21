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

/**
 * Drop credential keys from this checkout's local config. Used on the prove
 * cwd before the lane runs, not only on the isolated clone: lane bash can
 * read VERIT_PROVE_CWD from /proc/<ppid>/environ and git-config that path.
 */
export const stripCheckoutCredentialConfig = (repo: string): void => {
  const listed = git(["config", "--local", "--name-only", "--list"], repo);
  if (listed.status !== 0) return;
  for (const line of listed.stdout.split("\n")) {
    const key = line.trim();
    if (key === "" || !isCredentialConfigKey(key)) continue;
    git(["config", "--local", "--unset-all", key], repo);
  }
};

/** Strip extraheader / credential.helper on every prove-cwd path the host names. */
export const stripProveWorkspaceCredentials = (
  env: NodeJS.ProcessEnv = process.env,
  extra?: string,
): void => {
  const seen = new Set<string>();
  for (const raw of [extra, env.VERIT_PROVE_CWD, env.GITHUB_WORKSPACE]) {
    if (raw === undefined || raw === "") continue;
    const abs = resolve(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    stripCheckoutCredentialConfig(abs);
  }
};

/**
 * An isolated checkout of `source` at HEAD.
 *
 * Credential keys are stripped from the prove cwd first. A shared clone then
 * shares the object store and has its own config. A worktree would inherit
 * the source `http.*.extraheader`. clone --shared does not copy it, but lane
 * bash can still git-config the source via VERIT_PROVE_CWD in the parent
 * environ, so the source itself must be clean before tools run. If clone
 * fails, a tarball of the tracked tree at HEAD. If neither works, the lane
 * runs in `source` itself; the prove dirty-tree guard is then the remaining
 * net.
 */
export const openLaneCheckout = (source: string): LaneCheckout => {
  const base = mkdtempSync(join(tmpdir(), "verit-lane-checkout-"));
  const root = join(base, "tree");
  const wipe = () => rmSync(base, { recursive: true, force: true });
  const absSource = resolve(source);
  // The token must not sit in the source config while the lane runs. Hiding
  // VERIT_PROVE_CWD from the parent environ is not enough: bash can still
  // find the workspace.
  stripProveWorkspaceCredentials(process.env, absSource);

  // shared clone: own config, shared objects. Not a worktree, so a checkout
  // that persisted credentials cannot leak them through git config.
  const cloned = git(["clone", "--shared", "--quiet", absSource, root], absSource);
  if (cloned.status === 0) {
    stripCheckoutCredentialConfig(root);
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
