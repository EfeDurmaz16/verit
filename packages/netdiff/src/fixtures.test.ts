import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDiff, detectMoves, computeNetDiff, diffSection } from "./index";
import { inventedTokens, nonVerbatimPieces, falseMoves, grossReconstructs } from "./eval";

/**
 * The truthfulness checks, promoted from the field-eval scratch script to CI
 * properties over every committed real-PR fixture. These are the invariants
 * that make the move pre-pass safe to trust in a prompt: no invented token, no
 * non-verbatim quote, no move below the trust threshold, and exact gross
 * accounting. If any real diff ever breaks one, this fails before it ships.
 */
const dir = fileURLToPath(new URL("../fixtures", import.meta.url));
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".diff"))
  .sort();

it("the fixture corpus is present and covers the profiles", () => {
  // at least one of each: move-heavy is the synthetic in eval.ts, the rest here
  expect(fixtures).toContain("verit-rename.diff"); // mechanical-rename
  expect(fixtures).toContain("effect-refactor.diff"); // ordinary-feature
  expect(fixtures).toContain("vite-deps.diff"); // deps-bump
  expect(fixtures.length).toBeGreaterThanOrEqual(4);
});

describe("committed PR fixtures: truthfulness properties", () => {
  for (const name of fixtures) {
    const patch = readFileSync(`${dir}/${name}`, "utf8");
    const deltas = parseDiff(patch);
    const moves = detectMoves(deltas);
    const net = computeNetDiff(deltas, moves);
    const section = diffSection(patch);

    it(`${name}: zero invented tokens`, () => {
      expect(inventedTokens(net)).toBe(0);
    });

    it(`${name}: every rendered focus piece is verbatim`, () => {
      expect(nonVerbatimPieces(section, patch)).toBe(0);
    });

    it(`${name}: zero false moves`, () => {
      expect(falseMoves(moves)).toEqual([]);
    });

    it(`${name}: gross reconstruction holds`, () => {
      expect(grossReconstructs(net.stats)).toBe(true);
    });
  }
});
