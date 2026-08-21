import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * The composite action publishes its run's headline results as outputs, so a
 * caller can gate a later step on the Check without re-parsing verit's stdout.
 * This pins the two ends: the outputs declared in action.yml, and the CLI
 * writing each one to GITHUB_OUTPUT.
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

const outputs = ["conclusion", "run-id", "proof-page-url"];

describe("action outputs are declared and published", () => {
  it("declares each output, wired to the review step", () => {
    expect(actionYml).toMatch(/^outputs:/m);
    expect(actionYml).toContain("id: review");
    for (const o of outputs) {
      expect(actionYml, `output ${o} missing`).toContain(`steps.review.outputs.${o}`);
    }
  });

  it("has the CLI write each output to GITHUB_OUTPUT", () => {
    expect(mainTs).toContain("process.env.GITHUB_OUTPUT");
    for (const o of outputs) {
      expect(mainTs, `CLI never emits ${o}`).toContain(o);
    }
  });
});
