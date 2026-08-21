import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * The action, the README, and the code must agree on the configuration
 * surface. This test parses all three and fails on drift: a config var the
 * action sets but no doc row explains, a doc row duplicated, an action input
 * with no description or no wiring, or an env var the action sets that no code
 * reads. Kept mechanical on purpose, so adding a var forces the doc edit.
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
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** Every .ts file under packages and apps, concatenated, for "is it read". */
const sourceText = (): string => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  for (const top of ["packages", "apps"]) walk(join(ROOT, top));
  return out.join("\n");
};
const SOURCE = sourceText();

/** VERIT_* vars the action establishes: env: keys and `export VERIT_x=` lines. */
const actionConfigVars = (): string[] => {
  const set = new Set<string>();
  for (const m of actionYml.matchAll(/(?:^[ \t]*|export[ \t]+)(VERIT_[A-Z0-9_]+)[ \t]*[:=]/gm)) {
    set.add(m[1]!);
  }
  return [...set];
};

/** action.yml input names. */
const actionInputs = (): string[] => {
  const inputsBlock = /\ninputs:\n([\s\S]*?)\nruns:/.exec(actionYml)?.[1] ?? "";
  return [...inputsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
};

/** First-cell backticked keys in any README markdown table row. */
const readmeTableKeys = (): string[] =>
  [...readme.matchAll(/^\|\s*`([A-Z_][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!);

/** VERIT_* that the action sets for itself, never user config, so not a doc row. */
const ACTION_INTERNAL = new Set(["VERIT_CHECK_SHA"]);

describe("docs stay in sync with the action and the code", () => {
  const configVars = actionConfigVars();
  const documented = readmeTableKeys();
  const documentedCount = (v: string): number => documented.filter((d) => d === v).length;

  it("documents every config var the action sets, exactly once", () => {
    for (const v of configVars) {
      if (ACTION_INTERNAL.has(v)) continue;
      expect(documentedCount(v), `${v} should have exactly one README table row`).toBe(1);
    }
  });

  it("has no duplicate rows in the docs tables", () => {
    const seen = new Set<string>();
    const dupes = documented.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(dupes, `duplicate doc rows: ${dupes.join(", ")}`).toEqual([]);
  });

  it("sets no env var that no code reads", () => {
    for (const v of configVars) {
      if (ACTION_INTERNAL.has(v)) continue;
      expect(SOURCE.includes(v), `${v} is set by the action but read by no code`).toBe(true);
    }
  });

  it("gives every action input a description and wires it into the run", () => {
    for (const name of actionInputs()) {
      expect(
        new RegExp(`^ {2}${name}:\\n\\s+description:`, "m").test(actionYml),
        `input ${name} needs a description`,
      ).toBe(true);
      expect(
        actionYml.includes(`inputs.${name}`),
        `input ${name} is declared but never used in runs:`,
      ).toBe(true);
    }
  });

  it("wires fail-on end to end: input, env, docs, and code", () => {
    expect(actionInputs()).toContain("fail-on");
    expect(actionYml).toMatch(/VERIT_FAIL_ON:\s*\$\{\{\s*inputs\.fail-on\s*\}\}/);
    expect(documentedCount("VERIT_FAIL_ON")).toBe(1);
    expect(SOURCE).toContain("VERIT_FAIL_ON");
  });
});
