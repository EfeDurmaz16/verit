import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { detectProveCommand, repoSlugAt } from "@verit/adapter-prove";
import { laneConfigFromEnv } from "@verit/lane";

/*
 * `verit doctor`: check the local environment and config before a real run,
 * and say precisely what is wrong. Split in two so the verdict is testable
 * without spawning processes: gatherDoctorFacts does the I/O, evaluateDoctor is
 * pure and decides each status and the exit code.
 *
 * Exit non-zero only on a real problem: a broken lane the operator opted into,
 * a prove cwd that does not exist, a node too old to run verit. Everything a
 * run can still proceed without is a warning, not a failure.
 */

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorFacts {
  readonly nodeMajor: number;
  readonly pnpmVersion: string | null;
  readonly hasGithubCredential: boolean;
  readonly ghDetail: string;
  readonly lane: { readonly state: "disabled" | "ok" | "error"; readonly detail: string };
  readonly proveCwd: {
    /** VERIT_PROVE_CWD was set explicitly, so a missing path is a hard error. */
    readonly requested: boolean;
    readonly path: string;
    readonly exists: boolean;
    /** owner/repo from the checkout's origin remote, null when not a checkout. */
    readonly repoSlug: string | null;
    /** the test command verit would run here, null when none is detected. */
    readonly command: string | null;
  };
}

// Floors named on purpose. Below NODE_MIN, tsx and Effect do not run; the
// Action pins NODE_WANT, so a lower version reproduces CI badly. pnpm older
// than PNPM_MIN_MAJOR may not read this repo's lockfile format.
const NODE_MIN = 20;
const NODE_WANT = 22;
const PNPM_MIN_MAJOR = 9;

const majorOf = (version: string): number => Number(version.split(".")[0] ?? "0");

/** Pure verdict: given the facts, the per-check status and the exit code. */
export const evaluateDoctor = (f: DoctorFacts): { checks: DoctorCheck[]; exitCode: number } => {
  const checks: DoctorCheck[] = [];

  if (f.nodeMajor < NODE_MIN) {
    checks.push({
      name: "node",
      status: "fail",
      detail: `node ${f.nodeMajor} is too old. verit needs node >= ${NODE_MIN}, the Action pins ${NODE_WANT}.`,
    });
  } else if (f.nodeMajor < NODE_WANT) {
    checks.push({
      name: "node",
      status: "warn",
      detail: `node ${f.nodeMajor}. The Action runs node ${NODE_WANT}. Match it to reproduce CI.`,
    });
  } else {
    checks.push({ name: "node", status: "ok", detail: `node ${f.nodeMajor}` });
  }

  if (f.pnpmVersion === null) {
    checks.push({
      name: "pnpm",
      status: "warn",
      detail: "pnpm not found. verit builds and runs with pnpm. Install it, or use an npm ci install-command.",
    });
  } else if (majorOf(f.pnpmVersion) < PNPM_MIN_MAJOR) {
    checks.push({
      name: "pnpm",
      status: "warn",
      detail: `pnpm ${f.pnpmVersion}. This repo pins pnpm ${PNPM_MIN_MAJOR}+. An older major may not read the lockfile.`,
    });
  } else {
    checks.push({ name: "pnpm", status: "ok", detail: `pnpm ${f.pnpmVersion}` });
  }

  checks.push(
    f.hasGithubCredential
      ? { name: "github auth", status: "ok", detail: f.ghDetail }
      : {
          name: "github auth",
          status: "warn",
          detail: `${f.ghDetail}. Public PRs still work. Posting a Check needs a token with checks:write.`,
        },
  );

  if (f.lane.state === "ok") {
    checks.push({ name: "lane", status: "ok", detail: f.lane.detail });
  } else if (f.lane.state === "disabled") {
    checks.push({ name: "lane", status: "warn", detail: f.lane.detail });
  } else {
    checks.push({ name: "lane", status: "fail", detail: `lane misconfigured: ${f.lane.detail}` });
  }

  const p = f.proveCwd;
  if (!p.exists) {
    checks.push({
      name: "prove cwd",
      status: "fail",
      detail: p.requested
        ? `VERIT_PROVE_CWD points at ${p.path}, which does not exist.`
        : `prove cwd ${p.path} does not exist.`,
    });
  } else if (p.repoSlug === null) {
    checks.push({
      name: "prove cwd",
      status: "warn",
      detail: `${p.path} is not a GitHub checkout. prove refuses any tree whose origin it cannot read as owner/repo.`,
    });
  } else if (p.command === null) {
    checks.push({
      name: "prove cwd",
      status: "warn",
      detail: `${p.repoSlug}: no test command detected in ${p.path}. Set prove-command, or add a test script.`,
    });
  } else {
    checks.push({ name: "prove cwd", status: "ok", detail: `${p.repoSlug}: ${p.command}` });
  }

  return { checks, exitCode: checks.some((c) => c.status === "fail") ? 1 : 0 };
};

const exec = promisify(execFile);

/** First line of `<bin> --version`, or null when the binary is missing. */
const commandVersion = async (bin: string): Promise<string | null> => {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 10_000 });
    return stdout.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
};

const githubCredential = async (
  env: NodeJS.ProcessEnv,
): Promise<{ hasGithubCredential: boolean; ghDetail: string }> => {
  if (env.GITHUB_TOKEN) return { hasGithubCredential: true, ghDetail: "GITHUB_TOKEN is set" };
  if (env.GH_TOKEN) return { hasGithubCredential: true, ghDetail: "GH_TOKEN is set" };
  try {
    await exec("gh", ["auth", "status"], { timeout: 10_000 });
    return { hasGithubCredential: true, ghDetail: "gh CLI is authenticated" };
  } catch {
    return {
      hasGithubCredential: false,
      ghDetail: "no GITHUB_TOKEN or GH_TOKEN, and gh is not authenticated",
    };
  }
};

/** Classify the lane by reusing the real config resolver, so doctor and a run
    agree on what counts as coherent. */
const laneFacts = (env: NodeJS.ProcessEnv): DoctorFacts["lane"] => {
  const provider = env.VERIT_LANE_PROVIDER;
  if (provider === undefined || provider === "") {
    return {
      state: "disabled",
      detail: "VERIT_LANE_PROVIDER is unset. The lane is off and every Check is neutral, with no Understanding.",
    };
  }
  try {
    const cfg = laneConfigFromEnv(env);
    return { state: "ok", detail: `provider ${cfg.provider}, model ${cfg.model}, key present` };
  } catch (e) {
    return { state: "error", detail: e instanceof Error ? e.message : String(e) };
  }
};

export const gatherDoctorFacts = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorFacts> => {
  const nodeMajor = majorOf(process.versions.node);
  const pnpmVersion = await commandVersion("pnpm");
  const { hasGithubCredential, ghDetail } = await githubCredential(env);

  const requested = Boolean(env.VERIT_PROVE_CWD && env.VERIT_PROVE_CWD !== "");
  const path = resolve(env.VERIT_PROVE_CWD || env.GITHUB_WORKSPACE || process.cwd());
  const exists = existsSync(path);
  const repoSlug = exists ? await repoSlugAt(path) : null;
  const detected = exists ? await detectProveCommand(path) : null;
  const command = detected ? [detected.command, ...detected.args].join(" ") : null;

  return {
    nodeMajor,
    pnpmVersion,
    hasGithubCredential,
    ghDetail,
    lane: laneFacts(env),
    proveCwd: { requested, path, exists, repoSlug, command },
  };
};

const badge = (s: CheckStatus): string => (s === "ok" ? "ok  " : s === "warn" ? "warn" : "FAIL");

/** Print the report and return the exit code. */
export const runDoctor = async (env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const { checks, exitCode } = evaluateDoctor(await gatherDoctorFacts(env));
  for (const c of checks) console.log(`[${badge(c.status)}] ${c.name}: ${c.detail}`);
  const warns = checks.filter((c) => c.status === "warn").length;
  const fails = checks.filter((c) => c.status === "fail").length;
  console.log("");
  console.log(
    exitCode === 0
      ? `doctor: ok, ${warns} warning(s)`
      : `doctor: ${fails} problem(s), ${warns} warning(s)`,
  );
  return exitCode;
};
