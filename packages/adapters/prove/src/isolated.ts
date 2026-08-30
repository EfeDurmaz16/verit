import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DifferentialRun } from "./differential";
import type { RunnerJob, RunnerResult } from "./runner-main";
import { runnerChildEnv } from "./runner-env";

/*
 * Starting the untrusted side, from the side that has secrets.
 *
 * This is the only place the boundary is actually made. Everything else is a
 * check that assumes it: the runner refuses when a secret reached it, the probe
 * environment is an allowlist, the spec is verified with a public key. All of
 * that is worth nothing if the process holding the model key is the one
 * spawning probes, because a probe reads its parent's environment.
 *
 * So the runner is a child started with runnerChildEnv, its own environment
 * carrying nothing, and it is the runner that spawns probes. The secrets stay
 * one level up, in a process the probe is no longer the child of.
 */

const RUNNER_TIMEOUT_MARGIN_MS = 120_000;

const runnerEntry = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "runner-main.ts");

export interface IsolatedRun {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly run?: DifferentialRun;
}

/**
 * Run one probe on base and head in a process that never held a secret.
 *
 * The job file carries the instruction and a public key. It never carries a
 * signing key, a model key or a token: if this function is ever changed to pass
 * one, the runner refuses to start, which is the point of the check on the far
 * side.
 */
export const runDifferentialIsolated = async (input: {
  readonly job: RunnerJob;
  /** How to start a TypeScript entry point. Defaults to the local tsx. */
  readonly interpreter?: { command: string; args: readonly string[] };
}): Promise<IsolatedRun> => {
  const dir = await mkdtemp(join(tmpdir(), "verit-job-"));
  const jobPath = join(dir, "job.json");
  const outPath = join(dir, "result.json");

  try {
    await writeFile(jobPath, JSON.stringify(input.job), "utf8");

    const interpreter = input.interpreter ?? {
      command: process.execPath,
      args: ["--import", "tsx", runnerEntry()],
    };

    const result = await new Promise<IsolatedRun>((resolvePromise) => {
      const child = spawn(interpreter.command, [...interpreter.args, jobPath, outPath], {
        // The whole point: the runner's own environment has nothing in it.
        env: runnerChildEnv(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
        if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      });
      child.stdout.on("data", () => {
        // the runner speaks through the result file, not stdout
      });
      const timer = setTimeout(
        () => {
          if (child.pid !== undefined) {
            try {
              if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        },
        (input.job.timeoutMs ?? 600_000) + RUNNER_TIMEOUT_MARGIN_MS,
      );
      child.on("error", (e) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, problems: [`runner did not start: ${e.message}`] });
      });
      child.on("close", async () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(await readFile(outPath, "utf8")) as RunnerResult;
          resolvePromise(
            parsed.run !== undefined
              ? { ok: parsed.ok, problems: parsed.problems, run: parsed.run }
              : { ok: parsed.ok, problems: parsed.problems },
          );
        } catch {
          resolvePromise({
            ok: false,
            problems: [
              `the runner produced no result${stderr === "" ? "" : `: ${stderr.slice(-500)}`}`,
            ],
          });
        }
      });
    });

    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
