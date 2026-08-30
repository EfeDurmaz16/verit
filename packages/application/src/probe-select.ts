import type { Claim } from "@verit/domain";
import type { ProveCommand } from "@verit/ports";

/*
 * The claim to probe compiler, deterministic half.
 *
 * Before anything is generated, the repository is asked what it already has. A
 * project's own tests are the probes its maintainers already trust, and picking
 * the right one costs no model call. What this file does not do is guess: a
 * claim with no related test comes back with nothing, and the readiness policy
 * reports that honestly as needs-evidence rather than inventing coverage.
 *
 * Selection is separate from scoping on purpose. Which test relates to a claim
 * is a property of the tree and is pure. How to run only that test is a
 * property of the runner, is ecosystem-specific, and is allowed to fail: when
 * a runner cannot be narrowed safely, the whole suite is still an honest probe,
 * only a coarser one.
 */

/** A repository test that plausibly speaks to a claim. */
export interface ProbeCandidate {
  /** Repo-relative path of the test file. */
  readonly path: string;
  /** Why it was picked, in plain words, for the evidence body. */
  readonly reason: string;
  readonly claimIds: readonly string[];
}

const TEST_MARKERS = [
  ".test.",
  ".spec.",
  "_test.",
  "/test_",
  "/tests/",
  "/test/",
  "/__tests__/",
  "/spec/",
];

/** True for a path the repository treats as a test. Cheap and conventional. */
export const looksLikeTest = (path: string): boolean => {
  const p = `/${path.replace(/\\/g, "/")}`;
  return TEST_MARKERS.some((m) => p.includes(m));
};

const stripExt = (path: string): string => path.replace(/\.[^./]+$/, "");

const basenameNoExt = (path: string): string => {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return stripExt(base);
};

/**
 * The module a test file is named after, if any. `parse.test.ts` and
 * `test_parse.py` both point at `parse`. This is naming convention, not
 * analysis, so it is only ever a hint that has to agree with something else.
 */
const subjectOf = (testPath: string): string => {
  const base = basenameNoExt(testPath);
  return base
    .replace(/\.test$/, "")
    .replace(/\.spec$/, "")
    .replace(/_test$/, "")
    .replace(/^test_/, "");
};

const dirOf = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
};

export interface SelectInput {
  readonly claims: readonly Claim[];
  /** Every path the repository ships, repo-relative. */
  readonly repoFiles: readonly string[];
  /**
   * What each test file references, when the caller could read it. A test that
   * names a changed path is the strongest signal available without a parser.
   */
  readonly referencesOf?: (testPath: string) => readonly string[];
}

/**
 * Pick the repository's own tests that speak to each claim.
 *
 * Two signals, in order of trust. A test that references a changed path is
 * picked because it says so itself. A test named after a changed module in the
 * same package is picked on convention, which is weaker and is labelled as
 * such in its reason so the evidence body never oversells it.
 */
export const selectRepoNativeProbes = (input: SelectInput): readonly ProbeCandidate[] => {
  const tests = input.repoFiles.filter(looksLikeTest);
  const byPath = new Map<string, { reason: string; claimIds: Set<string> }>();

  const add = (path: string, reason: string, claimId: string) => {
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, { reason, claimIds: new Set([claimId]) });
      return;
    }
    existing.claimIds.add(claimId);
    // a referenced test outranks a conventionally named one
    if (reason.startsWith("references")) existing.reason = reason;
  };

  for (const claim of input.claims) {
    for (const region of claim.regions) {
      if (looksLikeTest(region)) {
        // The change edits a test. That test is still the most direct probe for
        // the claim, and the differential runner is what keeps the branch's own
        // edit of it from deciding the answer.
        add(region, `the change edits this test`, claim.id);
        continue;
      }
      const subject = basenameNoExt(region);
      const regionDir = dirOf(region);
      const regionNoExt = stripExt(region);

      for (const test of tests) {
        const referenced = input.referencesOf?.(test) ?? [];
        if (
          referenced.some((r) => r === region || stripExt(r).endsWith(regionNoExt) || r.includes(subject))
        ) {
          add(test, `references ${region}`, claim.id);
          continue;
        }
        if (subjectOf(test) === subject && (dirOf(test) === regionDir || dirOf(test).startsWith(regionDir))) {
          add(test, `named after ${region}, by convention`, claim.id);
        }
      }
    }
  }

  return [...byPath.entries()]
    .map(([path, v]) => ({ path, reason: v.reason, claimIds: [...v.claimIds] }))
    .sort((a, b) => a.path.localeCompare(b.path));
};

/* --------------------------------- scoping --------------------------------- */

/** Manifests that mark a directory as the thing a runner should be run from. */
const PACKAGE_MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  "composer.json",
];

/**
 * The directory a runner should be started in for this file.
 *
 * In a single package repository this is the root and nothing changes. In a
 * workspace it is the package that owns the file, which is the whole point:
 * running `vitest run packages/cli/src/x.test.ts` from the repository root
 * reports "No test files found", because the root config's include patterns do
 * not reach into a workspace member. Measured on verit itself, and it reported
 * unresolved on both sides, which was honest and useless.
 */
export const packageDirFor = (testPath: string, repoFiles: readonly string[]): string => {
  const files = new Set(repoFiles.map((f) => f.replace(/\\/g, "/")));
  let dir = dirOf(testPath.replace(/\\/g, "/"));
  while (dir !== "") {
    if (PACKAGE_MANIFESTS.some((m) => files.has(`${dir}/${m}`))) return dir;
    dir = dirOf(dir);
  }
  return "";
};

/** A command, and where to run it. An empty cwd means the repository root. */
export interface ScopedRunner {
  readonly command: ProveCommand;
  /** Repo-relative directory the runner starts in. */
  readonly cwd: string;
  /** The test path as the runner will see it, relative to that directory. */
  readonly argPath: string;
}

const relativeTo = (dir: string, path: string): string =>
  dir === "" ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;

/**
 * Narrow a suite command to one test file, and say where to run it.
 *
 * Returns null when the runner cannot be narrowed safely. Null is a real
 * answer: the caller falls back to the whole suite, which is a coarser probe
 * but an honest one. Guessing a flag that a runner would reinterpret is how a
 * probe silently stops measuring what it claims to.
 */
export const scopeRunnerToFile = (
  cmd: ProveCommand,
  testPath: string,
  repoFiles: readonly string[] = [],
): ScopedRunner | null => {
  const argv = [cmd.command, ...cmd.args].join(" ");
  const cwd = packageDirFor(testPath, repoFiles);
  const argPath = relativeTo(cwd, testPath);
  const scoped = (command: ProveCommand): ScopedRunner => ({ command, cwd, argPath });

  // Runners that take a path positionally and run only what they are given.
  const positional = ["vitest", "jest", "pytest", "mocha", "ava", "bun test", "deno test"];
  if (positional.some((r) => argv.includes(r))) {
    return scoped({ ...cmd, args: [...cmd.args, argPath] });
  }

  // A package-manager script needs the separator or the path lands on the
  // script runner instead of the test runner.
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd.command) && cmd.args.includes("test")) {
    if (cmd.command === "yarn") return scoped({ ...cmd, args: [...cmd.args, argPath] });
    return scoped({ ...cmd, args: [...cmd.args, "--", argPath] });
  }

  // go test takes a package, not a file, so a file path would not run. The
  // package is already the directory, so it runs from the module root.
  if (cmd.command === "go") {
    const pkg = dirOf(relativeTo(cwd, testPath));
    return {
      command: { ...cmd, args: ["test", `./${pkg === "" ? "" : `${pkg}/`}...`] },
      cwd,
      argPath,
    };
  }

  return null;
};
