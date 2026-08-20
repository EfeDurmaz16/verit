import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect, Either, Schema as S } from "effect";
import type { GitState, ProveCommand, ProveOutcome, ProvePort } from "@verit/ports";
import { StoreError } from "@verit/ports";

/*
 * THREAT MODEL: this file starts real processes on the machine running it.
 *
 *  - argv only. Every child is `spawn(cmd, args, { shell: false })`. Nothing
 *    read out of a repo, a PR, or a model is ever concatenated into a shell
 *    string, so a script named `test; rm -rf ~` stays one argv element.
 *  - The binary comes from a fixed table (pnpm/npm/yarn/bun/cargo/pytest)
 *    keyed on which manifest and lockfile exist. Repo files decide *whether* a
 *    known runner applies, never *what* binary runs. The one free-form source
 *    is VERIT_PROVE_CMD, which is operator config on this same machine.
 *  - `run` refuses unless the checkout at `cwd` is the repo the caller named,
 *    so reviewing a stranger's fork can never run their tests in your tree.
 *    Fail closed: no remote, no match, no run.
 *  - `run` refuses a second way. Given a `baseline` git snapshot from before
 *    the analysis stage, it re-reads the tree and will not run if HEAD or an
 *    uncommitted file moved. An earlier stage that edited the tree prove is
 *    about to measure turns the check neutral, never green.
 *  - Hard timeout, killed as a process group so runners cannot outlive it, and
 *    output is capped so a chatty suite cannot exhaust memory.
 *  - Locally the child env is an allowlist (see proveChildEnv), so keys and
 *    tokens in the operator's shell never leak into a repo's test scripts. On
 *    GitHub Actions the runner is the boundary and the env passes through.
 *
 * This is not a sandbox. It is "run the command the user already runs, where
 * they already run it." In CI the GitHub runner is the isolation boundary.
 */

const exec = promisify(execFile);

/* Keep the reason in the message: "prove refused" with no cause is unusable
   both in CI logs and in the workspace, which shows this text verbatim. */
const fail = (label: string) => (e: unknown) =>
  new StoreError(`${label}: ${e instanceof Error ? e.message : String(e)}`, e);

const TAIL_LINES = 100;
const CAPTURE_CHARS = 256_000;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Only the shape we read; a malformed manifest degrades to "no command". */
const PackageJson = S.Struct({
  scripts: S.optional(S.Record({ key: S.String, value: S.Unknown })),
});
const decodePackageJson = S.decodeUnknownEither(PackageJson);

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
};

/** Lockfile decides the runner; the default stays npm, which every JS repo has. */
const packageManager = (cwd: string): string => {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
};

/** Operator override: `VERIT_PROVE_CMD="cargo test --all"`, split into argv. */
const fromEnv = (): ProveCommand | null => {
  const raw = process.env.VERIT_PROVE_CMD?.trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const [command, ...args] = parts;
  if (!command) return null;
  return { command, args, source: "VERIT_PROVE_CMD" };
};

export const detectProveCommand = async (cwd: string): Promise<ProveCommand | null> => {
  const env = fromEnv();
  if (env) return env;

  const pkgRaw = await readJson(join(cwd, "package.json"));
  if (pkgRaw !== null) {
    const decoded = decodePackageJson(pkgRaw);
    if (Either.isRight(decoded)) {
      const scripts = decoded.right.scripts ?? {};
      for (const name of ["test", "build"] as const) {
        const script = scripts[name];
        if (typeof script === "string" && script.trim() !== "") {
          return {
            command: packageManager(cwd),
            args: ["run", name],
            source: `package.json#scripts.${name}`,
          };
        }
      }
    }
  }

  if (existsSync(join(cwd, "Cargo.toml"))) {
    return { command: "cargo", args: ["test"], source: "Cargo.toml" };
  }
  if (existsSync(join(cwd, "pyproject.toml"))) {
    return { command: "pytest", args: ["-q"], source: "pyproject.toml" };
  }
  return null;
};

const GITHUB_REMOTE = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

/** `owner/repo` of the checkout, from its origin remote. Null when unknown. */
export const repoSlugAt = async (cwd: string): Promise<string | null> => {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    const m = GITHUB_REMOTE.exec(stdout.trim());
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
};

const GIT_STATUS_BUFFER = 8 * 1024 * 1024;

/**
 * A snapshot of the working tree at `cwd`: HEAD plus a hash of the porcelain
 * status. Null when `cwd` is not a git checkout. The caller records one before
 * an analysis stage runs and hands it back to `run`, which compares against a
 * fresh read to see whether the tree moved in between.
 */
export const gitState = async (cwd: string): Promise<GitState | null> => {
  try {
    const head = await exec("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10_000 });
    const status = await exec("git", ["-C", cwd, "status", "--porcelain"], {
      timeout: 30_000,
      maxBuffer: GIT_STATUS_BUFFER,
    });
    // git status omits a tracked file once it is marked skip-worktree or
    // assume-unchanged, so an escaped lane can doctor a file on disk and leave
    // porcelain empty with HEAD unmoved. ls-files -v prints the index bit of
    // every path (S skip-worktree, lowercase assume-unchanged, H otherwise);
    // folding it into the hash means setting either bit moves the snapshot, and
    // the bit cannot be cleared without re-exposing the edit in porcelain. That
    // closes the "hide the doctoring so the hash still matches" evasion.
    const flags = await exec("git", ["-C", cwd, "ls-files", "-v"], {
      timeout: 30_000,
      maxBuffer: GIT_STATUS_BUFFER,
    });
    return {
      headSha: head.stdout.trim(),
      porcelainHash: createHash("sha256")
        .update(status.stdout)
        .update("\0")
        .update(flags.stdout)
        .digest("hex"),
      clean: status.stdout.trim() === "",
    };
  } catch {
    return null;
  }
};

/* Exact env keys a local test run may inherit. Everything else, and every
   credential in particular, must be named in VERIT_PROVE_ENV to pass. */
const ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "USER",
  "CI",
  "NODE_ENV",
  // language toolchains
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "PNPM_HOME",
  "NVM_DIR",
  "VOLTA_HOME",
  "PYTHONPATH",
  "VIRTUAL_ENV",
]);

const ENV_ALLOWED_PREFIXES = ["npm_config_"];

/**
 * The environment the untrusted verification command runs with.
 *
 * Locally this is an allowlist: PATH, HOME, toolchain vars, npm_config_*, and
 * whatever the operator names in VERIT_PROVE_ENV (comma-separated keys). API
 * keys and tokens sitting in the operator's shell (ANTHROPIC_API_KEY,
 * GITHUB_TOKEN, ...) never reach a repo's test scripts implicitly.
 *
 * On GitHub Actions the runner is the isolation boundary and workflows rely on
 * job-level env, so the full environment passes through unchanged there.
 */
export const proveChildEnv = (
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const forced = { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  if (base.GITHUB_ACTIONS === "true") {
    return { ...base, ...forced };
  }
  const declared = new Set(
    (base.VERIT_PROVE_ENV ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
  // Scrub by deletion so the augmented ProcessEnv shape (e.g. Next's required
  // NODE_ENV) stays satisfied without a cast.
  const child = { ...base };
  for (const key of Object.keys(child)) {
    const allowed =
      ENV_ALLOWLIST.has(key) ||
      declared.has(key) ||
      ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p));
    if (!allowed) delete child[key];
  }
  return { ...child, ...forced };
};

const tail = (text: string): string => {
  const lines = text.split("\n");
  return lines.slice(-TAIL_LINES).join("\n").trimEnd();
};

const shellDisplay = (c: ProveCommand): string => [c.command, ...c.args].join(" ");

interface RawRun {
  exitCode: number;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

const spawnCaptured = (cmd: ProveCommand, cwd: string, timeoutMs: number): Promise<RawRun> =>
  new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = spawn(cmd.command, [...cmd.args], {
      cwd,
      shell: false,
      // own process group, so the timeout kills the whole runner tree
      detached: process.platform !== "win32",
      env: proveChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    const absorb = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > CAPTURE_CHARS) output = output.slice(-CAPTURE_CHARS);
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);

    const stop = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        // a signalled death is a failure, and must never read as exit 0
        exitCode: code ?? (signal ? 137 : 1),
        timedOut,
        output,
        durationMs: Date.now() - started,
      });
    });
  });

export const makeProveRunner = (): ProvePort => ({
  detect: (cwd) =>
    Effect.tryPromise({
      try: () => detectProveCommand(resolve(cwd)),
      catch: fail("prove detect"),
    }),

  repoAt: (cwd) =>
    Effect.tryPromise({
      try: () => repoSlugAt(resolve(cwd)),
      catch: fail("prove repoAt"),
    }),

  run: ({ cwd, expectRepo, timeoutMs, baseline }) =>
    Effect.tryPromise({
      try: async (): Promise<ProveOutcome> => {
        const dir = resolve(cwd);
        const local = await repoSlugAt(dir);
        // fail closed: prove only ever runs in the repo the caller pointed at
        if (local === null || local.toLowerCase() !== expectRepo.toLowerCase()) {
          throw new Error(
            `refusing to prove: ${dir} is ${local ?? "not a GitHub checkout"}, expected ${expectRepo}`,
          );
        }
        const cmd = await detectProveCommand(dir);
        if (!cmd) {
          throw new Error(
            `no verification command found in ${dir} (set VERIT_PROVE_CMD to name one)`,
          );
        }
        // Read the tree as late as possible, right before the command runs, and
        // refuse if it moved since the analysis stage's snapshot.
        const state = await gitState(dir);
        const startedAt = new Date().toISOString();
        const moved =
          baseline != null &&
          (state === null ||
            state.headSha !== baseline.headSha ||
            state.porcelainHash !== baseline.porcelainHash);
        const common = {
          command: shellDisplay(cmd),
          source: cmd.source,
          cwd: dir,
          repo: local,
          headSha: state?.headSha ?? null,
          porcelainClean: state?.clean ?? false,
        };
        if (moved) {
          return {
            ...common,
            exitCode: 1,
            durationMs: 0,
            timedOut: false,
            logTail: "",
            log: "",
            startedAt,
            refused:
              "the working tree changed during analysis: HEAD or an uncommitted file differs from the snapshot taken before the analysis stage ran. prove will not measure a tree that moved under it, so this check stays neutral.",
          };
        }
        const raw = await spawnCaptured(cmd, dir, timeoutMs ?? DEFAULT_TIMEOUT_MS);
        return {
          ...common,
          exitCode: raw.exitCode,
          durationMs: raw.durationMs,
          timedOut: raw.timedOut,
          logTail: tail(raw.output),
          log: raw.output.trimEnd(),
          startedAt,
        };
      },
      catch: fail("prove"),
    }),
});
