import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ExecutionPolicy,
  ProbeOrigin,
  SideOutcome,
  SideOutcomeState,
  SideRecord,
} from "@verit/domain";
import type { ProveCommand } from "@verit/ports";
import { spawnCaptured } from "./index";

/*
 * Controlled base and head replay.
 *
 * The point of this module is that the two runs are the same experiment. Both
 * sides get their own worktree, created the same way from the same repository,
 * so neither inherits the other's installed state. The probe is materialized
 * once, in a directory outside both checkouts, and its bytes are hashed before
 * and after every run: if a side's code rewrote the probe, the run is not
 * evidence and says so.
 *
 * What may legitimately differ between the sides is recorded rather than
 * refused. A pull request is allowed to change the toolchain or the lockfile,
 * and that difference belongs in the evidence.
 */

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const GIT_BUFFER = 8 * 1024 * 1024;
export const DEFAULT_PROBE_TIMEOUT_MS = 10 * 60_000;
/** Repeats per side. One run cannot tell a real failure from a flaky one. */
export const DEFAULT_RUNS_PER_SIDE = 2;

/** The token in a probe's argv that is replaced with its custody path. */
export const PROBE_PATH_TOKEN = "{probe}";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const git = (args: readonly string[], cwd: string) =>
  exec("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_BUFFER });

/**
 * A probe, ready to run. `command` and `args` are argv, never a shell string.
 * Any occurrence of `{probe}` in `args` becomes the absolute path the probe was
 * materialized at, which is always outside both checkouts.
 */
export interface ProbeSpec {
  readonly id: string;
  /** The probe itself, verbatim. */
  readonly source: string;
  readonly origin: ProbeOrigin;
  readonly kind: "behavioral" | "precondition";
  /** File name the probe is written as inside the custody directory. */
  readonly fileName: string;
  /**
   * Repo-relative path the probe is copied to inside each side's worktree
   * before that side runs, for a runner that will only load a file from inside
   * the project. Custody stays the canonical copy: both sides get the same
   * bytes written in from it, so a repository whose own version of this file
   * differs between base and head still runs one identical probe.
   *
   * Leave unset for a probe the runner can load from custody directly.
   */
  readonly installPath?: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** sha256 of the probe source. The same hash must run on both sides. */
export const probeHash = (p: Pick<ProbeSpec, "source">): string => sha256(p.source);

export interface DifferentialInput {
  /** A checkout of the repository under review. Worktrees are cut from it. */
  readonly repoDir: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly probe: ProbeSpec;
  readonly policy: ExecutionPolicy;
  readonly runsPerSide?: number;
  readonly timeoutMs?: number;
  /**
   * Optional per-side preparation, e.g. installing dependencies. It runs inside
   * that side's worktree, with the same argv on both sides. Its failure makes
   * the side an execution error, never a behavioral failure.
   */
  readonly prepare?: ProveCommand | null;
}

export interface DifferentialRun {
  readonly base: SideOutcome;
  readonly head: SideOutcome;
  readonly sides: readonly [SideRecord, SideRecord];
  /** The probe hash observed on each side. Equal is the gate. */
  readonly observedProbeHashes: { readonly base: string; readonly head: string };
  /** False when a run mutated the probe, which voids the comparison. */
  readonly probeHeldOutside: boolean;
  readonly logs: { readonly base: string; readonly head: string };
}

/* --------------------------- per-side fingerprint -------------------------- */

/** Files that say what a side resolved to. Read as bytes, never executed. */
const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
] as const;

const TOOLCHAIN_FILES = [
  ".nvmrc",
  ".node-version",
  "rust-toolchain",
  "rust-toolchain.toml",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
] as const;

const digestOf = async (dir: string, names: readonly string[]): Promise<string> => {
  const h = createHash("sha256");
  const seen: string[] = [];
  for (const name of names) {
    try {
      const bytes = await readFile(join(dir, name));
      h.update(name);
      h.update(bytes);
      seen.push(name);
    } catch {
      // absent on this side, which is itself a difference worth hashing
    }
  }
  return seen.length === 0 ? "" : `${seen.join(",")}@${h.digest("hex").slice(0, 16)}`;
};

/**
 * What this side resolved to. Reading manifests is deliberate: it costs no
 * subprocess and cannot be influenced by the code under test at run time.
 */
const sideFingerprint = async (
  side: "base" | "head",
  dir: string,
  sha: string,
  policy: ExecutionPolicy,
): Promise<SideRecord> => {
  const selectedToolchain = await digestOf(dir, TOOLCHAIN_FILES);
  const resolvedDependencies = await digestOf(dir, DEPENDENCY_FILES);
  return {
    side,
    sha,
    selectedToolchain,
    resolvedDependencies,
    environmentDigest: sha256(`${policy.digest}|${selectedToolchain}|${resolvedDependencies}`),
  };
};

/* ------------------------------- side running ------------------------------ */

const stateOf = (raw: { exitCode: number; timedOut: boolean }): SideOutcomeState => {
  if (raw.timedOut) return "execution-error";
  // 127 is what runOneSuite uses for a runner that never started, and what a
  // shellless spawn reports when the binary is missing. The probe did not
  // apply here; that is not the repository failing a test.
  if (raw.exitCode === 127) return "incompatible";
  return raw.exitCode === 0 ? "pass" : "fail";
};

const collapse = (observed: readonly SideOutcomeState[]): SideOutcomeState => {
  const first = observed[0];
  if (first === undefined) return "execution-error";
  return observed.every((s) => s === first) ? first : "unstable";
};

const runSide = async (input: {
  side: "base" | "head";
  dir: string;
  probePath: string;
  probe: ProbeSpec;
  runs: number;
  timeoutMs: number;
  prepare?: ProveCommand | null;
}): Promise<{ outcome: SideOutcome; log: string }> => {
  const { side, dir, probePath, probe, runs, timeoutMs } = input;

  if (input.prepare) {
    try {
      const prep = await spawnCaptured(input.prepare, dir, timeoutMs);
      if (prep.exitCode !== 0) {
        // Preparation is infrastructure. A failed install is not the repository
        // failing its own behavior, so it must never read as a behavioral fail.
        return {
          outcome: {
            side,
            state: "execution-error",
            exitCode: prep.exitCode,
            runs: 1,
            observedStates: ["execution-error"],
            artifactRefs: [],
          },
          log: prep.output,
        };
      }
    } catch (e) {
      return {
        outcome: {
          side,
          state: "execution-error",
          exitCode: null,
          runs: 1,
          observedStates: ["execution-error"],
          artifactRefs: [],
        },
        log: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // When the runner can only load the probe from inside the project, copy it
  // in from custody. Doing it per side, from the canonical copy, is what makes
  // the two runs the same experiment even when the repository ships its own
  // differing version of that path.
  if (probe.installPath !== undefined) {
    const installed = join(dir, probe.installPath);
    await mkdir(dirname(installed), { recursive: true });
    await copyFile(probePath, installed);
  }

  const cmd: ProveCommand = {
    command: probe.command,
    args: probe.args.map((a) =>
      a === PROBE_PATH_TOKEN
        ? probe.installPath !== undefined
          ? join(dir, probe.installPath)
          : probePath
        : a,
    ),
    source: `probe:${probe.id}`,
  };

  const observed: SideOutcomeState[] = [];
  let lastExit: number | null = null;
  let log = "";
  for (let i = 0; i < runs; i++) {
    try {
      const raw = await spawnCaptured(cmd, dir, timeoutMs);
      observed.push(stateOf(raw));
      lastExit = raw.exitCode;
      log = raw.output;
    } catch (e) {
      // A spawn that never started: the probe does not apply on this side.
      observed.push("incompatible");
      lastExit = 127;
      log = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    outcome: {
      side,
      state: collapse(observed),
      exitCode: lastExit,
      runs: observed.length,
      observedStates: observed,
      artifactRefs: [],
    },
    log,
  };
};

/* --------------------------------- the run --------------------------------- */

/**
 * Run one probe on base and on head under one policy.
 *
 * Both sides are worktrees cut the same way, so the comparison is between two
 * commits and not between a warm workspace and a cold checkout. The probe is
 * written once into a directory neither side can reach by relative path, and
 * re-hashed after each side runs. A moved probe means the two runs were not the
 * same experiment, and the caller must not grade the result.
 */
export const runDifferential = async (input: DifferentialInput): Promise<DifferentialRun> => {
  const repoDir = resolve(input.repoDir);
  const runsPerSide = input.runsPerSide ?? DEFAULT_RUNS_PER_SIDE;
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const expected = probeHash(input.probe);

  // Custody: outside both checkouts, so neither commit's code owns the bytes.
  const custody = await mkdtemp(join(tmpdir(), "verit-probe-"));
  const probePath = join(custody, input.probe.fileName);
  await writeFile(probePath, input.probe.source, "utf8");

  const workRoot = await mkdtemp(join(tmpdir(), "verit-sides-"));
  const baseDir = join(workRoot, "base");
  const headDir = join(workRoot, "head");

  const observedProbeHashes = { base: expected, head: expected };
  let probeHeldOutside = true;

  const readProbe = async (): Promise<string> => {
    try {
      return sha256(await readFile(probePath, "utf8"));
    } catch {
      return "";
    }
  };

  const cleanup = async () => {
    for (const dir of [baseDir, headDir]) {
      try {
        await git(["worktree", "remove", "--force", dir], repoDir);
      } catch {
        // already gone, or never created
      }
    }
    await rm(workRoot, { recursive: true, force: true });
    await rm(custody, { recursive: true, force: true });
  };

  try {
    await git(["worktree", "add", "--detach", baseDir, input.baseSha], repoDir);
    await git(["worktree", "add", "--detach", headDir, input.headSha], repoDir);

    const baseRecord = await sideFingerprint("base", baseDir, input.baseSha, input.policy);
    const headRecord = await sideFingerprint("head", headDir, input.headSha, input.policy);

    const base = await runSide({
      side: "base",
      dir: baseDir,
      probePath,
      probe: input.probe,
      runs: runsPerSide,
      timeoutMs,
      prepare: input.prepare,
    });
    observedProbeHashes.base = await readProbe();

    const head = await runSide({
      side: "head",
      dir: headDir,
      probePath,
      probe: input.probe,
      runs: runsPerSide,
      timeoutMs,
      prepare: input.prepare,
    });
    observedProbeHashes.head = await readProbe();

    probeHeldOutside =
      observedProbeHashes.base === expected && observedProbeHashes.head === expected;

    return {
      base: base.outcome,
      head: head.outcome,
      sides: [baseRecord, headRecord],
      observedProbeHashes,
      probeHeldOutside,
      logs: { base: base.log, head: head.log },
    };
  } finally {
    await cleanup();
  }
};
