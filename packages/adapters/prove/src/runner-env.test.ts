import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_PATH_TOKEN, runDifferential } from "./differential";
import { VERIT_SECRET_KEYS, proveChildEnv, runnerChildEnv, secretsIn } from "./index";

/*
 * What a probe can read.
 *
 * A probe is untrusted twice: it may be a test the pull request author wrote,
 * and on the generated path it is code a model wrote. So these tests do not ask
 * whether the environment looks tidy. They put a real secret in a real place
 * and then check a real subprocess cannot reach it.
 *
 * The specific regression they exist for: proveChildEnv passes the whole
 * environment through on GitHub Actions, which is defensible for a repository's
 * own test command and indefensible for a probe. runnerChildEnv has no such
 * branch, and the first test here is that difference.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const loaded = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  VERIT_LANE_API_KEY: "sk-or-REAL-MODEL-KEY",
  GITHUB_TOKEN: "ghs_REAL_WRITE_TOKEN",
  VERIT_INGEST_TOKEN: "ingest-REAL",
  VERIT_JOB_SPEC_SECRET: "signing-REAL",
  VERIT_TOKEN_DIR: "/tmp/verit-tok.XXXX",
  ANTHROPIC_API_KEY: "sk-ant-REAL",
  ACME_DEPLOY_TOKEN: "customer-secret-we-never-heard-of",
  MY_DB_PASSWORD: "hunter2",
  ...over,
});

describe("the probe environment is an allowlist everywhere", () => {
  it("drops every secret we ship", () => {
    const child = runnerChildEnv(loaded());
    for (const key of VERIT_SECRET_KEYS) {
      expect(child[key]).toBeUndefined();
    }
  });

  it("drops a secret belonging to somebody else's CI, which no list of ours names", () => {
    const child = runnerChildEnv(loaded());
    expect(child["ACME_DEPLOY_TOKEN"]).toBeUndefined();
    expect(child["MY_DB_PASSWORD"]).toBeUndefined();
    expect(secretsIn(child)).toEqual([]);
  });

  it("has no GitHub Actions escape hatch, which prove does have", () => {
    const onCi = loaded({ GITHUB_ACTIONS: "true" });
    // prove hands the whole environment through on CI, on purpose
    expect(proveChildEnv(onCi)["VERIT_LANE_API_KEY"]).toBe("sk-or-REAL-MODEL-KEY");
    // a probe gets the allowlist there too
    expect(runnerChildEnv(onCi)["VERIT_LANE_API_KEY"]).toBeUndefined();
    expect(secretsIn(runnerChildEnv(onCi))).toEqual([]);
  });

  it("keeps what a suite actually needs", () => {
    const child = runnerChildEnv(loaded({ CARGO_HOME: "/c", npm_config_registry: "https://r" }));
    expect(child["PATH"]).toBeTruthy();
    expect(child["CARGO_HOME"]).toBe("/c");
    expect(child["npm_config_registry"]).toBe("https://r");
    expect(child["CI"]).toBe("1");
  });

  it("lets an operator name an extra key, but not a secret-shaped one", () => {
    const child = runnerChildEnv(
      loaded({
        MY_FIXTURE_DIR: "/fixtures",
        VERIT_PROBE_ENV: "MY_FIXTURE_DIR,ACME_DEPLOY_TOKEN",
      }),
    );
    expect(child["MY_FIXTURE_DIR"]).toBe("/fixtures");
    // naming it does not make it safe
    expect(child["ACME_DEPLOY_TOKEN"]).toBeUndefined();
  });
});

describe("the unisolated path refuses rather than leaking through its parent", () => {
  it("will not run a probe from a process that holds a secret", async () => {
    const repo = mkdtempSync(join(tmpdir(), "verit-refuse-"));
    dirs.push(repo);
    const saved = { ...process.env };
    Object.assign(process.env, { VERIT_LANE_API_KEY: "sk-or-CANARY" });
    try {
      await expect(
        runDifferential({
          repoDir: repo,
          baseSha: "a",
          headSha: "b",
          probe: {
            id: "p",
            source: "process.exit(0);",
            origin: "generated",
            kind: "behavioral",
            fileName: "p.mjs",
            command: process.execPath,
            args: [PROBE_PATH_TOKEN],
          },
          policy: { orchestration: "o", isolation: "i", digest: "d" },
        }),
      ).rejects.toThrow(/refusing to run a probe from a process holding/);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k];
      }
      Object.assign(process.env, saved);
    }
  }, 60_000);

  it("names the isolated entry point, so the fix is obvious from the message", async () => {
    const repo = mkdtempSync(join(tmpdir(), "verit-refuse-"));
    dirs.push(repo);
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_TOKEN: "ghs_CANARY" });
    try {
      await runDifferential({
        repoDir: repo,
        baseSha: "a",
        headSha: "b",
        probe: {
          id: "p",
          source: "process.exit(0);",
          origin: "generated",
          kind: "behavioral",
          fileName: "p.mjs",
          command: process.execPath,
          args: [PROBE_PATH_TOKEN],
        },
        policy: { orchestration: "o", isolation: "i", digest: "d" },
      });
      expect.unreachable("should have refused");
    } catch (e) {
      expect(String(e)).toContain("runDifferentialIsolated");
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k];
      }
      Object.assign(process.env, saved);
    }
  }, 60_000);
});
