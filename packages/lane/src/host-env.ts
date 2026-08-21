import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The lane host (the CLI process, the Action step after exec) must not have
 * GITHUB_TOKEN or VERIT_INGEST_TOKEN in its exec environ. laneChildEnv already
 * keeps those keys out of the bash child. That is not enough: the child is the
 * same user and can read /proc/<ppid>/environ, which is the host's exec-time
 * snapshot. delete process.env.FOO does not rewrite that snapshot. Re-exec
 * without the keys does.
 *
 * Secrets still needed for ingest / upload / Check post ride in process.env
 * after the re-exec (or after reading VERIT_TOKEN_DIR). That write does not
 * appear in /proc/self/environ.
 */

export const LANE_HOST_SECRET_KEYS = ["GITHUB_TOKEN", "VERIT_INGEST_TOKEN"] as const;

export type LaneHostSecretKey = (typeof LANE_HOST_SECRET_KEYS)[number];

export type LaneHostSecrets = {
  readonly GITHUB_TOKEN?: string;
  readonly VERIT_INGEST_TOKEN?: string;
};

const TOKEN_DIR_VAR = "VERIT_TOKEN_DIR";

const nonempty = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  return value.trim() === "" ? undefined : value;
};

const readUnlink = (dir: string, name: string): string | undefined => {
  const path = join(dir, name);
  try {
    const raw = readFileSync(path, "utf8");
    unlinkSync(path);
    return nonempty(raw);
  } catch {
    return undefined;
  }
};

/**
 * Collect host tokens from process env and from VERIT_TOKEN_DIR (github /
 * ingest files). The files are unlinked here so a later bash cannot cat them.
 */
export const takeLaneHostSecrets = (env: NodeJS.ProcessEnv = process.env): LaneHostSecrets => {
  const dir = env[TOKEN_DIR_VAR];
  let fileGithub: string | undefined;
  let fileIngest: string | undefined;
  if (dir !== undefined && dir !== "") {
    fileGithub = readUnlink(dir, "github");
    fileIngest = readUnlink(dir, "ingest");
    try {
      rmdirSync(dir);
    } catch {
      /* leftover files, or already gone */
    }
    delete env[TOKEN_DIR_VAR];
  }
  return {
    GITHUB_TOKEN: nonempty(env.GITHUB_TOKEN) ?? fileGithub,
    VERIT_INGEST_TOKEN: nonempty(env.VERIT_INGEST_TOKEN) ?? fileIngest,
  };
};

let held: { GITHUB_TOKEN?: string; VERIT_INGEST_TOKEN?: string } = {};

const applyLaneHostSecrets = (
  secrets: LaneHostSecrets,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  for (const key of LANE_HOST_SECRET_KEYS) {
    const value = secrets[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  held = {
    GITHUB_TOKEN: secrets.GITHUB_TOKEN,
    VERIT_INGEST_TOKEN: secrets.VERIT_INGEST_TOKEN,
  };
};

/** Remove host tokens from process.env. Values are kept for restoreLaneHostSecrets. */
export const dropLaneHostSecrets = (env: NodeJS.ProcessEnv = process.env): void => {
  held = {
    GITHUB_TOKEN: nonempty(env.GITHUB_TOKEN) ?? held.GITHUB_TOKEN,
    VERIT_INGEST_TOKEN: nonempty(env.VERIT_INGEST_TOKEN) ?? held.VERIT_INGEST_TOKEN,
  };
  for (const key of LANE_HOST_SECRET_KEYS) delete env[key];
};

/** Put host tokens back on process.env after the lane returns. */
export const restoreLaneHostSecrets = (env: NodeJS.ProcessEnv = process.env): void => {
  applyLaneHostSecrets(held, env);
};

const writeTokenDir = (secrets: LaneHostSecrets): string => {
  const dir = mkdtempSync(join(tmpdir(), "verit-host-tok-"));
  chmodSync(dir, 0o700);
  const write = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    const path = join(dir, name);
    writeFileSync(path, value, { encoding: "utf8" });
    chmodSync(path, 0o600);
  };
  write("github", secrets.GITHUB_TOKEN);
  write("ingest", secrets.VERIT_INGEST_TOKEN);
  return dir;
};

const envWithoutHostSecrets = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: Record<string, string> = {};
  const skip = new Set<string>([...LANE_HOST_SECRET_KEYS, TOKEN_DIR_VAR]);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (skip.has(key)) continue;
    env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
};

/** Keep a TypeScript loader when argv[1] is the .ts entry (node --import tsx). */
const reexecArgs = (): string[] => {
  const rest = process.argv.slice(1);
  const entry = rest[0] ?? "";
  if (entry.endsWith(".ts") || entry.endsWith(".mts") || entry.endsWith(".cts")) {
    return ["--import", "tsx", ...rest];
  }
  return rest;
};

const reexecWithoutHostSecrets = async (secrets: LaneHostSecrets): Promise<void> => {
  const dir = writeTokenDir(secrets);
  const env = envWithoutHostSecrets(process.env);
  env[TOKEN_DIR_VAR] = dir;

  const child = spawn(process.execPath, reexecArgs(), {
    env,
    stdio: "inherit",
  });

  const wipeDir = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* child unlinks on a healthy run */
    }
  };

  try {
    await new Promise<never>((_resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        wipeDir();
        if (signal) {
          try {
            process.kill(process.pid, signal);
          } catch {
            process.exit(1);
          }
          return;
        }
        process.exit(code ?? 1);
      });
    });
  } catch (e) {
    wipeDir();
    const message = e instanceof Error ? e.message : String(e);
    console.error(`lane host re-exec failed: ${message}`);
    process.exit(1);
  }
};

/**
 * If this process still has host tokens in process.env, re-exec without those
 * keys so /proc/self/environ is clean. The child reads VERIT_TOKEN_DIR and
 * restores the values onto process.env for API use.
 */
export const ensureLaneHostScrubbed = async (): Promise<void> => {
  const secrets = takeLaneHostSecrets();
  const dirty = LANE_HOST_SECRET_KEYS.some((key) => nonempty(process.env[key]) !== undefined);
  if (!dirty) {
    applyLaneHostSecrets(secrets);
    return;
  }
  await reexecWithoutHostSecrets(secrets);
};
