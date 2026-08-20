import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { executeLaneTool, laneChildEnv, truncateResult, TOOL_RESULT_CHARS } from "./tools";

const root = mkdtempSync(join(tmpdir(), "verit-lane-"));
writeFileSync(join(root, "hello.ts"), "export const NEEDLE_TOKEN = 1;\n");
mkdirSync(join(root, "sub"));
writeFileSync(join(root, "sub", "note.md"), "plain note\n");

const outside = mkdtempSync(join(tmpdir(), "verit-outside-"));
writeFileSync(join(outside, "secret.txt"), "secret\n");
symlinkSync(outside, join(root, "escape-link"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("truncateResult", () => {
  it("marks a truncated result explicitly", () => {
    const big = "x".repeat(TOOL_RESULT_CHARS + 100);
    const cut = truncateResult(big);
    expect(cut).toContain("[verit-lane: truncated, showing first");
    expect(cut.length).toBeLessThan(big.length);
  });

  it("leaves short results alone", () => {
    expect(truncateResult("short")).toBe("short");
  });
});

describe("laneChildEnv", () => {
  it("keeps the toolchain vars a tool needs and forces the CI markers", () => {
    const env = laneChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CARGO_HOME: "/home/u/.cargo",
      npm_config_registry: "https://registry.npmjs.org",
      NODE_ENV: "test",
      SOME_RANDOM_SECRET: "s",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.CARGO_HOME).toBe("/home/u/.cargo");
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org");
    expect(env.NODE_ENV).toBe("test");
    expect(env.SOME_RANDOM_SECRET).toBeUndefined();
    expect(env.CI).toBe("1");
    expect(env.NO_COLOR).toBe("1");
  });

  it("passes only the keys the operator names in VERIT_LANE_ENV", () => {
    const env = laneChildEnv({
      PATH: "/usr/bin",
      VERIT_LANE_ENV: "DATABASE_URL, MY_FLAG",
      DATABASE_URL: "postgres://localhost/x",
      MY_FLAG: "on",
      OTHER: "nope",
    });
    expect(env.DATABASE_URL).toBe("postgres://localhost/x");
    expect(env.MY_FLAG).toBe("on");
    expect(env.OTHER).toBeUndefined();
  });

  // The blocker: on GitHub Actions the lane bash used to inherit the whole
  // environment, so GITHUB_TOKEN and every planted secret reached a
  // model-driven subprocess. The allowlist must hold on CI too, with no
  // exception. Ten secret shapes go in, none survive.
  it("lets no secret reach a lane subprocess, even on GitHub Actions", () => {
    const secrets = {
      GITHUB_TOKEN: "ghp_deadbeef",
      VERIT_INGEST_TOKEN: "vit_deadbeef",
      ANTHROPIC_API_KEY: "sk-ant-deadbeef",
      OPENAI_API_KEY: "sk-deadbeef",
      AWS_SECRET_ACCESS_KEY: "aws/deadbeef",
      NPM_TOKEN: "npm_deadbeef",
      RELEASE_SIGNING_SECRET: "s3cr3t",
      DB_PASSWORD: "hunter2",
      STRIPE_SECRET_KEY: "sk_live_deadbeef",
      SLACK_BEARER_TOKEN: "Bearer deadbeef",
    };
    const env = laneChildEnv({
      GITHUB_ACTIONS: "true",
      PATH: "/usr/bin",
      ...secrets,
    });
    // the tool can still run: PATH survives.
    expect(env.PATH).toBe("/usr/bin");
    // none of the ten secret shapes made it through.
    for (const key of Object.keys(secrets)) {
      expect(env[key]).toBeUndefined();
    }
    // catch any *_TOKEN / *_KEY / *_SECRET / *_PASSWORD the loop missed.
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/_TOKEN$|_KEY$|_SECRET$|_PASSWORD$/);
    }
  });
});

describe("executeLaneTool", () => {
  it("reads a file inside the root", () => {
    const r = executeLaneTool(root, "read_file", { path: "hello.ts" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("NEEDLE_TOKEN");
  });

  it("rejects path traversal", () => {
    const r = executeLaneTool(root, "read_file", { path: "../outside.txt" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
  });

  it("rejects absolute paths outside the root", () => {
    const r = executeLaneTool(root, "read_file", { path: "/etc/hosts" });
    expect(r.isError).toBe(true);
  });

  it("rejects symlink escapes", () => {
    const r = executeLaneTool(root, "read_file", { path: "escape-link/secret.txt" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
  });

  it("rejects malformed input instead of throwing", () => {
    const r = executeLaneTool(root, "read_file", { nope: true });
    expect(r.isError).toBe(true);
  });

  it("lists a directory", () => {
    const r = executeLaneTool(root, "list_dir", {});
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello.ts");
    expect(r.content).toContain("sub/");
  });

  it("greps by regex and returns path:line matches", () => {
    const r = executeLaneTool(root, "grep", { pattern: "NEEDLE_[A-Z]+" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("hello.ts");
    expect(r.content).toContain("NEEDLE_TOKEN");
  });

  it("reports no matches as a normal result", () => {
    const r = executeLaneTool(root, "grep", { pattern: "definitely_not_here_9x9" });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("(no matches)");
  });

  it("runs bash in a scrubbed environment: no API keys reach the child", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const r = executeLaneTool(root, "bash", {
        command: 'echo "key=[${ANTHROPIC_API_KEY:-}]"',
      });
      expect(r.isError).toBe(false);
      expect(r.content).toBe("key=[]");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("reports a failing bash command as an error with its exit code", () => {
    const r = executeLaneTool(root, "bash", { command: "echo boom >&2; exit 3" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit 3");
    expect(r.content).toContain("boom");
  });

  it("returns an error for an unknown tool", () => {
    const r = executeLaneTool(root, "rm_rf", {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown tool");
  });
});
