import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Effect, Either, Schema as S } from "effect";
import type { ProveCommand, ProveOutcome, ProvePort } from "@cyclops/ports";
import { StoreError } from "@cyclops/ports";

/*
 * THREAT MODEL — this file starts real processes on the machine running it.
 *
 *  - argv only. Every child is `spawn(cmd, args, { shell: false })`. Nothing
 *    read out of a repo, a PR, or a model is ever concatenated into a shell
 *    string, so a script named `test; rm -rf ~` stays one argv element.
 *  - The binary comes from a fixed table (pnpm/npm/yarn/bun/cargo/pytest)
 *    keyed on which manifest and lockfile exist. Repo files decide *whether* a
 *    known runner applies, never *what* binary runs. The one free-form source
 *    is CYCLOPS_PROVE_CMD, which is operator config on this same machine.
 *  - `run` refuses unless the checkout at `cwd` is the repo the caller named,
 *    so reviewing a stranger's fork can never run their tests in your tree.
 *    Fail closed: no remote, no match, no run.
 *  - Hard timeout, killed as a process group so runners cannot outlive it, and
 *    output is capped so a chatty suite cannot exhaust memory.
 *
 * This is not a sandbox. It is "run the command the user already runs, where
 * they already run it" — in CI the GitHub runner is the isolation boundary.
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

/** Operator override: `CYCLOPS_PROVE_CMD="cargo test --all"`, split into argv. */
const fromEnv = (): ProveCommand | null => {
  const raw = process.env.CYCLOPS_PROVE_CMD?.trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const [command, ...args] = parts;
  if (!command) return null;
  return { command, args, source: "CYCLOPS_PROVE_CMD" };
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
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
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

  run: ({ cwd, expectRepo, timeoutMs }) =>
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
            `no verification command found in ${dir} (set CYCLOPS_PROVE_CMD to name one)`,
          );
        }
        const startedAt = new Date().toISOString();
        const raw = await spawnCaptured(cmd, dir, timeoutMs ?? DEFAULT_TIMEOUT_MS);
        return {
          command: shellDisplay(cmd),
          source: cmd.source,
          cwd: dir,
          repo: local,
          exitCode: raw.exitCode,
          durationMs: raw.durationMs,
          timedOut: raw.timedOut,
          logTail: tail(raw.output),
          startedAt,
        };
      },
      catch: fail("prove"),
    }),
});
