import { describe, expect, it } from "vitest";
import {
  parseDiff,
  detectMoves,
  computeNetDiff,
  diffSection,
  MOVE_SIMILARITY_THRESHOLD,
  type NetDiff,
} from "./index";

/**
 * Known ceilings. Each test pins the current, deliberate behavior at a corner
 * where netdiff chooses to do less. They are not bugs. They are here so a future
 * change to any one of them fails a test and becomes a visible decision, with
 * the upgrade path named in the comment, instead of a silent regression.
 */

const editHunk = (o: number, dels: readonly string[], n: number, adds: readonly string[]): string =>
  [`@@ -${o},${dels.length} +${n},${adds.length} @@`, ...dels.map((l) => `-${l}`), ...adds.map((l) => `+${l}`)].join(
    "\n",
  );
const modifiedFile = (path: string, hunks: readonly string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
const deletedFile = (path: string, body: readonly string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, "+++ /dev/null", `@@ -1,${body.length} +0,0 @@`, ...body.map((l) => `-${l}`)].join(
    "\n",
  );
const addedFile = (path: string, body: readonly string[]): string =>
  [`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)].join(
    "\n",
  );
const netOf = (patch: string): NetDiff => {
  const deltas = parseDiff(patch);
  return computeNetDiff(deltas, detectMoves(deltas));
};

describe("ceiling: near-move glued-line degradation is fail-open", () => {
  // CEILING. A block that moves clean is a move. The same block with one extra
  // adjacent line glued into the landing run drops below MOVE_SIMILARITY_THRESHOLD
  // and is NOT reported as a move_with_edit with a guessed residual. It fails
  // open: the whole added run is new, the whole removed run is deleted, and the
  // reviewer sees every line. A false move here would hide a real edit inside a
  // block the tool wrongly called "moved". Cheaper to show it twice than to lie.
  // Upgrade path: a residual-aware near matcher that peels the glued line before
  // scoring. Until then, fail open stays the safe default.
  const base = [
    "const step_a = compute(alpha, 1);",
    "const step_b = compute(beta, 2);",
    "const step_c = compute(gamma, 3);",
    "const step_d = compute(delta, 4);",
    "const step_e = compute(epsilon, 5);",
  ];
  const foreign = "const step_f = teardown(zeta, 6);";

  it("moves clean when the block lands intact", () => {
    const moves = detectMoves(parseDiff(deletedFile("src/from.ts", base) + "\n" + addedFile("src/to.ts", base)));
    expect(moves.pairs).toHaveLength(1);
    expect(moves.pairs[0]?.kind).toBe("pure_move");
    expect(moves.newBlocks).toEqual([]);
    expect(moves.deletedBlocks).toEqual([]);
  });

  it("degrades to new plus deleted, not a false move, with one glued line", () => {
    const patch = deletedFile("src/from.ts", base) + "\n" + addedFile("src/to.ts", [...base, foreign]);
    const moves = detectMoves(parseDiff(patch));
    expect(moves.pairs).toEqual([]);
    expect(moves.newBlocks).toHaveLength(1);
    expect(moves.deletedBlocks).toHaveLength(1);
    const net = netOf(patch);
    expect(net.stats.movePct).toBe(0);
    expect(net.regions.map((r) => r.kind).sort()).toEqual(["deletion", "new"]);
    // the threshold this corner sits just under; named so a change to it is visible
    expect(MOVE_SIMILARITY_THRESHOLD).toBe(0.85);
  });
});

describe("ceiling: over-cap replacement hunks silently produce no focus", () => {
  // CEILING. In-place token focus pairs removed and added lines with an LCS that
  // is O(removed x added). Past RESIDUAL_PAIR_CELL_CAP (250,000 cells, in index.ts)
  // the whole hunk is skipped: no inline focus, no REAL CHANGES block. The lines
  // still appear as net content to review; only the token-level attention markers
  // are dropped. A generated 500-plus-line table must not turn the focus pass
  // quadratic. Upgrade path: a banded or windowed LCS that stays linear on huge
  // hunks. Until then, silence past the cap is the deliberate floor.
  it("a single pair over the cap silences the hunk", () => {
    // 501 x 501 = 251,001 cells, over the 250,000 cap
    const dels = Array.from({ length: 501 }, (_, i) => `row(${i}, "left");`);
    const adds = Array.from({ length: 501 }, (_, i) => `row(${i}, "right");`);
    const patch = modifiedFile("src/gen.ts", [editHunk(1, dels, 1, adds)]);
    expect(netOf(patch).inlineEdits).toEqual([]);
    expect(diffSection(patch)).not.toContain("REAL CHANGES");
  });

  it("the same hunk one cell under the cap still produces focus", () => {
    // 500 x 500 = 250,000 cells, exactly at the cap: still paired
    const dels = Array.from({ length: 500 }, (_, i) => `row(${i}, "left");`);
    const adds = Array.from({ length: 500 }, (_, i) => `row(${i}, "right");`);
    const net = netOf(modifiedFile("src/gen2.ts", [editHunk(1, dels, 1, adds)]));
    expect(net.inlineEdits).toHaveLength(500);
  });
});

describe("ceiling: token-only aggregation merges same bumps across unrelated files", () => {
  // CEILING. The whole-diff focus groups in-place edits by their (removedTokens,
  // addedTokens) pair alone. File and line are not part of the key. So the same
  // token bump in two unrelated files collapses to one "repeated" summary line.
  // That is the point for a mechanical rename. It also means two coincidentally
  // identical one-token edits in unrelated code read as one pattern, and the
  // per-site locations move into the example list. Upgrade path: a same-file or
  // same-symbol guard on the group key if coincidental collisions ever mislead.
  it("two unrelated files with the same bump render one summary line", () => {
    const patch = [
      modifiedFile("src/one.ts", [editHunk(10, ['const brand = "cyclops";'], 10, ['const brand = "verit";'])]),
      modifiedFile("src/two.ts", [editHunk(20, ["export const NAME = cyclops;"], 20, ["export const NAME = verit;"])]),
    ].join("\n");
    const net = netOf(patch);
    expect(net.inlineEdits).toHaveLength(2);
    expect(new Set(net.inlineEdits.map((e) => e.file)).size).toBe(2);

    const focus = diffSection(patch)
      .split("\n")
      .filter((l) => l.startsWith("real change"));
    expect(focus).toEqual([
      "real change, repeated 2x across 2 files: `cyclops` -> `verit` (at src/one.ts:10, src/two.ts:20)",
    ]);
    // named once, not once per site
    expect(diffSection(patch)).not.toContain("real change at ");
  });
});
