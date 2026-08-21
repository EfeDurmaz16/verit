import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * The review step used to put GITHUB_TOKEN and VERIT_INGEST_TOKEN on the CLI
 * process environ. Lane bash then read /proc/<ppid>/environ. The step must
 * persist those values off the environ, unset them, and exec the CLI.
 */

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "action.yml"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("repo root with action.yml not found");
};

const ROOT = repoRoot();
const actionYml = readFileSync(join(ROOT, "action.yml"), "utf8");
const mainTs = readFileSync(join(ROOT, "packages/cli/src/main.ts"), "utf8");

const stepAround = (anchor: string): string => {
  const at = actionYml.indexOf(anchor);
  if (at < 0) return "";
  const start = actionYml.lastIndexOf("\n    - ", at);
  let end = actionYml.indexOf("\n    - ", at + anchor.length);
  if (end < 0) end = actionYml.length;
  return actionYml.slice(start, end);
};

describe("review step drops host tokens before the lane", () => {
  it("unsets GITHUB_TOKEN and VERIT_INGEST_TOKEN, then execs the CLI", () => {
    const step = stepAround("main.ts dogfood");
    expect(step, "review step not found").not.toBe("");
    expect(step).toMatch(/unset GITHUB_TOKEN VERIT_INGEST_TOKEN/);
    expect(step).toMatch(/export VERIT_TOKEN_DIR=/);
    expect(step).toMatch(/exec pnpm exec tsx packages\/cli\/src\/main\.ts dogfood/);
  });

  it("has the CLI re-exec the lane host without those keys", () => {
    expect(mainTs).toContain("ensureLaneHostScrubbed");
  });
});
