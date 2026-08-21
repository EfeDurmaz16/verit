import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * docs/compatibility.md is the version history of the configuration surface.
 * This test fails when it drifts: an action input, an env var the action sets,
 * or an env var the README documents that has no row in the compatibility
 * table. Mechanical on purpose, so adding a knob forces the compat-table edit.
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
const compat = readFileSync(join(ROOT, "docs/compatibility.md"), "utf8");

/** action.yml input names. */
const actionInputs = (): string[] => {
  const block = /\ninputs:\n([\s\S]*?)\nruns:/.exec(actionYml)?.[1] ?? "";
  return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
};

/** VERIT_* vars the action establishes, minus the ones it sets for itself. */
const ACTION_INTERNAL = new Set(["VERIT_CHECK_SHA"]);
const actionConfigVars = (): string[] => {
  const set = new Set<string>();
  for (const m of actionYml.matchAll(/(?:^[ \t]*|export[ \t]+)(VERIT_[A-Z0-9_]+)[ \t]*[:=]/gm)) {
    if (!ACTION_INTERNAL.has(m[1]!)) set.add(m[1]!);
  }
  return [...set];
};

/** Uppercase backticked first-cell keys in any README table row. */
const readmeConfigKeys = (): string[] =>
  [...readme.matchAll(/^\|\s*`([A-Z_][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!);

/** Every backticked first-cell key in the compat tables, kebab or upper. */
const compatKeys = (): string[] =>
  [...compat.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_-]*)`\s*\|/gm)].map((m) => m[1]!);

describe("docs/compatibility.md covers the whole config surface", () => {
  const keys = new Set(compatKeys());

  it("has a row for every action input", () => {
    for (const input of actionInputs()) {
      expect(keys.has(input), `input ${input} has no compatibility row`).toBe(true);
    }
  });

  it("has a row for every VERIT_* var the action sets", () => {
    for (const v of actionConfigVars()) {
      expect(keys.has(v), `${v} is set by the action but has no compatibility row`).toBe(true);
    }
  });

  it("has a row for every env var the README documents", () => {
    for (const v of readmeConfigKeys()) {
      expect(keys.has(v), `${v} is in the README config table but has no compatibility row`).toBe(true);
    }
  });

  it("lists no key twice", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const k of compatKeys()) {
      if (seen.has(k)) dupes.push(k);
      else seen.add(k);
    }
    expect(dupes, `duplicate compatibility rows: ${dupes.join(", ")}`).toEqual([]);
  });

  it("gives every row a concrete version, not a placeholder", () => {
    // Each data row is `| `key` | X.Y.Z | ... `. The Added cell must be a
    // real semver, never TODO or blank, or the history is meaningless.
    const rows = [...compat.matchAll(/^\|\s*`[^`]+`\s*\|\s*([^|]+?)\s*\|/gm)];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r[1], `bad Added version: "${r[1]}"`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
