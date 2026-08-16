import { describe, expect, it } from "vitest";
import {
  analyzeDiff,
  computeNetDiff,
  describeMoves,
  detectMoves,
  netDiffChars,
  parseDiff,
  planReview,
  type NetDiff,
} from "./index";

/* ------------------------------ fixture tools ------------------------------ */

const addedFile = (path: string, body: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body.map((l) => `+${l}`),
  ].join("\n");

const deletedFile = (path: string, body: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${body.length} +0,0 @@`,
    ...body.map((l) => `-${l}`),
  ].join("\n");

/** one hunk that removes `dels` and adds `adds` at the given starts, no context */
const editHunk = (
  oldStart: number,
  dels: readonly string[],
  newStart: number,
  adds: readonly string[],
): string =>
  [
    `@@ -${oldStart},${dels.length} +${newStart},${adds.length} @@`,
    ...dels.map((l) => `-${l}`),
    ...adds.map((l) => `+${l}`),
  ].join("\n");

const modifiedFile = (path: string, hunks: readonly string[]): string =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");

/** a distinctive function body, `n` lines, parameterized so fixtures never collide */
const fn = (name: string, n: number): string[] => [
  `export const ${name} = (x: number): number => {`,
  ...Array.from({ length: n - 3 }, (_, i) => `  const ${name}_v${i} = x * ${i + 2} + weight("${name}", ${i});`),
  `  return ${name}_v${n - 4};`,
  "};",
];

const netOf = (patch: string): NetDiff => {
  const deltas = parseDiff(patch);
  return computeNetDiff(deltas, detectMoves(deltas));
};

/* --------------------------------- parsing -------------------------------- */

describe("parseDiff", () => {
  it("captures per-file hunks with old and new line positions", () => {
    const patch = modifiedFile("src/a.ts", [
      [
        "@@ -3,4 +3,5 @@ context",
        " keep",
        "-old one",
        "+new one",
        "+new two",
        " tail",
        "-old two",
      ].join("\n"),
    ]);
    const [d] = parseDiff(patch);
    expect(d).toBeDefined();
    expect(d?.oldPath).toBe("src/a.ts");
    expect(d?.newPath).toBe("src/a.ts");
    expect(d?.status).toBe("modified");
    const lines = d?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 3, 3],
      ["del", 4, null],
      ["add", null, 4],
      ["add", null, 5],
      ["ctx", 5, 6],
      ["del", 6, null],
    ]);
  });

  it("reads added, deleted, and git-renamed files", () => {
    const patch = [
      addedFile("src/new.ts", ["a", "b"]),
      deletedFile("src/gone.ts", ["x"]),
      [
        "diff --git a/src/old.ts b/src/moved.ts",
        "similarity index 97%",
        "rename from src/old.ts",
        "rename to src/moved.ts",
        "--- a/src/old.ts",
        "+++ b/src/moved.ts",
        editHunk(4, ["const retries = 3;"], 4, ["const retries = 5;"]),
      ].join("\n"),
    ].join("\n");
    const deltas = parseDiff(patch);
    expect(deltas.map((d) => d.status)).toEqual(["added", "deleted", "renamed"]);
    expect(deltas[2]?.oldPath).toBe("src/old.ts");
    expect(deltas[2]?.newPath).toBe("src/moved.ts");
  });

  it("does not mistake a removed '-- ' line for a file header", () => {
    // "-" + "-- item" prints as "--- item": the @@ counts must keep it in the hunk
    const patch = modifiedFile("notes.md", [
      ["@@ -1,2 +1,1 @@", "-content", "--- item two", "+content kept"].join("\n"),
    ]);
    const deltas = parseDiff(patch);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.hunks[0]?.lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual([
      "content",
      "-- item two",
    ]);
  });

  it("splits concatenated plain diffs without git headers", () => {
    const patch = [
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+beta",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1,1 +1,1 @@",
      "-gamma",
      "+delta",
    ].join("\n");
    const deltas = parseDiff(patch);
    expect(deltas.map((d) => d.newPath)).toEqual(["one.ts", "two.ts"]);
  });

  it("keeps a binary file entry as a delta with no hunks", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const deltas = parseDiff(patch);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.hunks).toHaveLength(0);
  });

  it("parses nothing from non-diff input", () => {
    expect(parseDiff("just some prose\nwith lines\n")).toEqual([]);
    expect(parseDiff("")).toEqual([]);
  });
});

/* ------------------------------ move detection ----------------------------- */

describe("detectMoves: pure move", () => {
  const body = fn("quote", 12);
  const indented = body.map((l) => `  ${l}`);
  const patch = [
    modifiedFile("src/pay.ts", [editHunk(10, body, 10, [])]),
    modifiedFile("src/quote.ts", [editHunk(90, [], 90, indented)]),
  ].join("\n");

  it("pairs a function moved across files, whitespace ignored", () => {
    const moves = detectMoves(parseDiff(patch));
    expect(moves.pairs).toHaveLength(1);
    const pair = moves.pairs[0];
    expect(pair?.kind).toBe("pure_move");
    expect(pair?.similarity).toBe(1);
    expect(pair?.from.file).toBe("src/pay.ts");
    expect(pair?.to.file).toBe("src/quote.ts");
    expect(pair?.toResidual).toEqual([]);
    expect(moves.newBlocks).toEqual([]);
    expect(moves.deletedBlocks).toEqual([]);
  });

  it("leaves nothing in the net diff and reports the move share", () => {
    const net = netOf(patch);
    expect(net.regions).toEqual([]);
    expect(net.stats.netLines).toBe(0);
    expect(net.stats.movePct).toBe(100);
    expect(net.stats.netChars).toBe(0);
  });
});

describe("detectMoves: file split", () => {
  const partA = fn("alpha", 20);
  const partB = fn("bravo", 20);
  const patch = [
    deletedFile("src/big.ts", [...partA, "", ...partB]),
    addedFile("src/alpha.ts", partA),
    addedFile("src/bravo.ts", partB),
  ].join("\n");

  it("matches each half of a deleted file into its new home", () => {
    const moves = detectMoves(parseDiff(patch));
    expect(moves.pairs).toHaveLength(2);
    expect(moves.pairs.every((p) => p.kind === "pure_move")).toBe(true);
    expect(moves.pairs.map((p) => p.to.file).sort()).toEqual(["src/alpha.ts", "src/bravo.ts"]);
    expect(moves.newBlocks).toEqual([]);
    expect(moves.deletedBlocks).toEqual([]);
  });

  it("is not reported as a rename: each part covers half the old file", () => {
    const net = netOf(patch);
    expect(net.renameCandidates).toEqual([]);
    expect(net.stats.netLines).toBe(0);
  });
});

describe("detectMoves: move with edit", () => {
  const body = fn("charge", 30);
  const edited = body.map((l) =>
    l.includes("charge_v3") ? l.replace("x * 5", "x * 50") : l,
  );
  const patch = [
    modifiedFile("src/charge.ts", [editHunk(5, body, 5, [])]),
    modifiedFile("src/payments/charge.ts", [editHunk(40, [], 40, edited)]),
  ].join("\n");

  it("classifies the landed block and carries the residual edit", () => {
    const moves = detectMoves(parseDiff(patch));
    expect(moves.pairs).toHaveLength(1);
    const pair = moves.pairs[0];
    expect(pair?.kind).toBe("move_with_edit");
    expect(pair?.similarity).toBeGreaterThanOrEqual(0.85);
    expect(pair?.similarity).toBeLessThan(1);
    expect(pair?.toResidual).toHaveLength(1);
    expect(pair?.toResidual.join("\n")).toContain("x * 50");
    expect(pair?.fromResidual).toHaveLength(1);
  });

  it("keeps only the residual in the net diff, pointing at the origin", () => {
    const net = netOf(patch);
    expect(net.regions).toHaveLength(1);
    const region = net.regions[0];
    expect(region?.kind).toBe("residual");
    expect(region?.file).toBe("src/payments/charge.ts");
    expect(region?.movedFrom?.file).toBe("src/charge.ts");
    expect(region?.lines).toHaveLength(1);
    expect(net.stats.netLines).toBe(1);
  });
});

describe("rename candidates", () => {
  it("keeps what git already marked, with its edit count", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/moved.ts",
      "similarity index 97%",
      "rename from src/old.ts",
      "rename to src/moved.ts",
      "--- a/src/old.ts",
      "+++ b/src/moved.ts",
      editHunk(4, ["const retries = 3;"], 4, ["const retries = 5;"]),
    ].join("\n");
    const net = netOf(patch);
    expect(net.renameCandidates).toEqual([
      { from: "src/old.ts", to: "src/moved.ts", editedLines: 1 },
    ]);
  });

  it("detects a delete-plus-add whole-file move with one edited line", () => {
    const body = fn("ledger", 40);
    const edited = body.map((l) => (l.includes("ledger_v7") ? l.replace("x * 9", "x * 90") : l));
    const patch = [
      deletedFile("src/ledger.ts", body),
      addedFile("src/core/ledger.ts", edited),
    ].join("\n");
    const net = netOf(patch);
    expect(net.renameCandidates).toEqual([
      { from: "src/ledger.ts", to: "src/core/ledger.ts", editedLines: 1 },
    ]);
    expect(net.stats.netLines).toBe(1);
  });
});

describe("detectMoves: rewrite with add/drop ratio near 1", () => {
  const dels = Array.from({ length: 20 }, (_, i) => `const legacy_${i} = parseCsv(row, ${i});`);
  const adds = Array.from({ length: 20 }, (_, i) => `let modern${i} = decodeJson(payload).field${i};`);
  const patch = modifiedFile("src/import.ts", [editHunk(10, dels, 10, adds)]);

  it("treats an in-place rewrite as new plus deleted, not a move", () => {
    const moves = detectMoves(parseDiff(patch));
    expect(moves.pairs).toEqual([]);
    const net = netOf(patch);
    expect(net.stats.movePct).toBe(0);
    expect(net.stats.netLines).toBe(20);
    expect(net.stats.deletedLines).toBe(20);
    expect(net.regions.map((r) => r.kind).sort()).toEqual(["deletion", "new"]);
  });
});

describe("detectMoves: pathological repeated block", () => {
  const block = [
    "try {",
    "  const lock = await acquire(key);",
    "  return await handler(lock);",
    "} finally {",
    "  release(key);",
    "}",
  ];
  const patch = [
    modifiedFile("src/r1.ts", [editHunk(5, block, 5, [])]),
    modifiedFile("src/r2.ts", [editHunk(9, block, 9, [])]),
    modifiedFile("src/r3.ts", [editHunk(13, block, 13, [])]),
    modifiedFile("src/a1.ts", [editHunk(20, [], 20, block)]),
    modifiedFile("src/a2.ts", [editHunk(30, [], 30, block)]),
  ].join("\n");

  it("pairs copies one to one and never invents an edit", () => {
    const moves = detectMoves(parseDiff(patch));
    expect(moves.pairs).toHaveLength(2);
    expect(moves.pairs.every((p) => p.kind === "pure_move")).toBe(true);
    expect(moves.newBlocks).toEqual([]);
    expect(moves.deletedBlocks).toHaveLength(1);
    expect(moves.deletedBlocks[0]?.lines).toHaveLength(6);
  });

  it("keeps the leftover copy as a real deletion in the net diff", () => {
    const net = netOf(patch);
    expect(net.regions.map((r) => r.kind)).toEqual(["deletion"]);
    expect(net.stats.deletedLines).toBe(6);
    // 12 added lines matched, 12 of 18 removed matched
    expect(net.stats.movedAdded).toBe(12);
    expect(net.stats.movedRemoved).toBe(12);
  });
});

/* ------------------------------- review plan ------------------------------- */

describe("planReview", () => {
  const riskyResidual = fn("checkout", 12);
  const editedResidual = riskyResidual.map((l) =>
    l.includes("checkout_v2") ? l.replace("x * 4", "x * 400") : l,
  );
  const patch = [
    modifiedFile("src/lib/old.ts", [editHunk(3, riskyResidual, 3, [])]),
    modifiedFile("src/payments/checkout.ts", [editHunk(50, [], 50, editedResidual)]),
    modifiedFile("src/auth/login.ts", [
      editHunk(8, [], 8, ["if (session.expired) {", "  throw new AuthError('expired');", "}"]),
    ]),
    addedFile(
      "src/lib/table.ts",
      Array.from({ length: 120 }, (_, i) => `export const row${i} = ["cell", ${i}];`),
    ),
  ].join("\n");
  const net = netOf(patch);

  it("ranks risky small regions above big boring ones", () => {
    const plan = planReview(net, 1_000_000);
    expect(plan.regions.map((r) => r.file)).toEqual([
      "src/payments/checkout.ts",
      "src/auth/login.ts",
      "src/lib/table.ts",
    ]);
    expect(plan.unreviewed).toEqual([]);
    expect(plan.packedChars).toBeGreaterThan(0);
  });

  it("packs to the budget and lists the leftovers as unreviewed", () => {
    const risky = net.regions.filter((r) => r.file !== "src/lib/table.ts");
    const riskyChars = risky.reduce((n, r) => n + r.content.length + 1, 0);
    const plan = planReview(net, riskyChars + 200);
    expect(plan.regions.map((r) => r.file)).toEqual([
      "src/payments/checkout.ts",
      "src/auth/login.ts",
    ]);
    expect(plan.unreviewed.map((r) => r.file)).toEqual(["src/lib/table.ts"]);
    expect(plan.packedChars).toBeLessThanOrEqual(riskyChars + 200);
    expect(plan.totalNetChars).toBe(net.stats.netChars);
  });

  it("truncates the best leftover when enough budget remains", () => {
    const bigOnly = netOf(
      addedFile(
        "src/lib/table.ts",
        Array.from({ length: 120 }, (_, i) => `export const row${i} = ["cell", ${i}];`),
      ),
    );
    const plan = planReview(bigOnly, 1_000);
    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]?.truncated).toBe(true);
    expect(plan.regions[0]?.content.length).toBeLessThan(1_000);
    expect(plan.packedChars).toBeLessThanOrEqual(1_000);
    expect(plan.unreviewed).toEqual([]);
  });

  it("gives up on truncation below the floor and reports the region unreviewed", () => {
    const bigOnly = netOf(
      addedFile(
        "src/lib/table.ts",
        Array.from({ length: 120 }, (_, i) => `export const row${i} = ["cell", ${i}];`),
      ),
    );
    const plan = planReview(bigOnly, 100);
    expect(plan.regions).toEqual([]);
    expect(plan.unreviewed).toHaveLength(1);
    expect(plan.packedChars).toBe(0);
  });
});

/* --------------------------- gross reconstruction -------------------------- */

const FIXTURES: Record<string, string> = {
  pureMove: [
    modifiedFile("src/pay.ts", [editHunk(10, fn("quote", 12), 10, [])]),
    modifiedFile("src/quote.ts", [editHunk(90, [], 90, fn("quote", 12).map((l) => `  ${l}`))]),
  ].join("\n"),
  fileSplit: [
    deletedFile("src/big.ts", [...fn("alpha", 20), "", ...fn("bravo", 20)]),
    addedFile("src/alpha.ts", fn("alpha", 20)),
    addedFile("src/bravo.ts", fn("bravo", 20)),
  ].join("\n"),
  moveWithEdit: [
    modifiedFile("src/charge.ts", [editHunk(5, fn("charge", 30), 5, [])]),
    modifiedFile("src/payments/charge.ts", [
      editHunk(
        40,
        [],
        40,
        fn("charge", 30).map((l) => (l.includes("charge_v3") ? l.replace("x * 5", "x * 50") : l)),
      ),
    ]),
  ].join("\n"),
  renameOneLine: [
    deletedFile("src/ledger.ts", fn("ledger", 40)),
    addedFile(
      "src/core/ledger.ts",
      fn("ledger", 40).map((l) => (l.includes("ledger_v7") ? l.replace("x * 9", "x * 90") : l)),
    ),
  ].join("\n"),
  rewrite: modifiedFile("src/import.ts", [
    editHunk(
      10,
      Array.from({ length: 20 }, (_, i) => `const legacy_${i} = parseCsv(row, ${i});`),
      10,
      Array.from({ length: 20 }, (_, i) => `let modern${i} = decodeJson(payload).field${i};`),
    ),
  ]),
  repeatedBlock: [
    modifiedFile("src/r1.ts", [editHunk(5, ["dup();", "dup2();", "dup3();"], 5, [])]),
    modifiedFile("src/r2.ts", [editHunk(9, ["dup();", "dup2();", "dup3();"], 9, [])]),
    modifiedFile("src/a1.ts", [editHunk(20, [], 20, ["dup();", "dup2();", "dup3();"])]),
  ].join("\n"),
  mixed: [
    modifiedFile("src/mixed.ts", [
      editHunk(3, ["old();"], 3, ["renewed();", "extra();"]),
      editHunk(30, fn("mover", 10), 60, []),
    ]),
    modifiedFile("src/landing.ts", [editHunk(7, [], 7, fn("mover", 10))]),
  ].join("\n"),
};

describe("net plus moves reconstructs the gross counts", () => {
  for (const [name, patch] of Object.entries(FIXTURES)) {
    it(`holds for ${name}`, () => {
      const net = netOf(patch);
      const s = net.stats;
      expect(s.movedAdded + s.residualAdded + s.newLines).toBe(s.grossAdded);
      expect(s.movedRemoved + s.residualRemoved + s.deletedLines).toBe(s.grossRemoved);
      expect(s.netLines).toBe(s.newLines + s.residualAdded);
    });
  }
});

describe("determinism", () => {
  it("returns byte-identical analysis for the same input", () => {
    for (const patch of Object.values(FIXTURES)) {
      const a = analyzeDiff(patch, 10_000);
      const b = analyzeDiff(patch, 10_000);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

/* ------------------------------ prose and entry ---------------------------- */

describe("describeMoves", () => {
  it("summarizes the move share in one plain paragraph", () => {
    const net = netOf(FIXTURES["moveWithEdit"] ?? "");
    const text = describeMoves(net);
    expect(text).toContain("moved without edit");
    expect(text).toContain("residual");
    expect(text).not.toContain("—");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("says when nothing moved", () => {
    const net = netOf(FIXTURES["rewrite"] ?? "");
    expect(describeMoves(net)).toContain("No moved code was detected.");
  });
});

describe("netDiffChars", () => {
  it("returns the net rendered size for a parseable patch", () => {
    const patch = FIXTURES["pureMove"] ?? "";
    expect(netDiffChars(patch)).toBe(0);
    expect(netDiffChars(patch)).toBeLessThan(patch.length);
  });

  it("falls back to gross length when the input is not a unified diff", () => {
    expect(netDiffChars("x".repeat(1_000))).toBe(1_000);
    const headerOnly = "--- a/x.ts\n+++ b/x.ts\n+ not a real hunk\n";
    expect(netDiffChars(headerOnly)).toBe(headerOnly.length);
  });
});

describe("empty input", () => {
  it("yields an empty analysis and an empty plan", () => {
    const a = analyzeDiff("", 1_000);
    expect(a.deltas).toEqual([]);
    expect(a.net.regions).toEqual([]);
    expect(a.net.stats.grossAdded).toBe(0);
    expect(a.plan.regions).toEqual([]);
    expect(a.plan.packedChars).toBe(0);
  });
});

/* --------------------------- synthetic 80% move ---------------------------- */

/** ~5k changed lines, 80% of them a pure cross-file move. Fully deterministic. */
export const syntheticMovePatch = (): string => {
  const files: string[] = [];
  for (let f = 0; f < 10; f++) {
    const body: string[] = [];
    for (let g = 0; g < 4; g++) {
      if (g > 0) body.push("");
      body.push(...fn(`mod${f}_fn${g}`, 49));
    }
    files.push(deletedFile(`src/old/mod${f}.ts`, body));
  }
  // land the same functions regrouped across new files: forces cross-file moves
  for (let f = 0; f < 10; f++) {
    const body: string[] = [];
    for (let g = 0; g < 4; g++) {
      if (g > 0) body.push("");
      body.push(...fn(`mod${(f + 1 + g) % 10}_fn${g}`, 49));
    }
    files.push(addedFile(`src/new/mod${f}.ts`, body));
  }
  files.push(
    addedFile(
      "src/new/feature.ts",
      Array.from({ length: 500 }, (_, i) => `export const feature${i} = build(${i});`),
    ),
  );
  files.push(
    deletedFile(
      "src/old/legacy.ts",
      Array.from({ length: 500 }, (_, i) => `const legacy${i} = teardown(${i});`),
    ),
  );
  return files.join("\n");
};

describe("synthetic 5k-line 80% move patch", () => {
  const patch = syntheticMovePatch();
  const analysis = analyzeDiff(patch, 120_000);
  const s = analysis.net.stats;

  it("is the right shape: about 5k gross lines", () => {
    expect(s.grossAdded + s.grossRemoved).toBeGreaterThan(4_800);
    expect(s.grossAdded + s.grossRemoved).toBeLessThan(5_200);
  });

  it("factors out about 80% as moves", () => {
    expect(s.movePct).toBeGreaterThanOrEqual(78);
    expect(s.movePct).toBeLessThanOrEqual(82);
    expect(s.newLines).toBe(500);
    expect(s.deletedLines).toBe(500);
    expect(s.residualAdded).toBe(0);
  });

  it("shrinks the review payload well below the gross patch", () => {
    expect(s.netChars).toBeLessThan(patch.length / 5);
    expect(analysis.plan.unreviewed).toEqual([]);
    expect(analysis.plan.packedChars).toBeLessThanOrEqual(120_000);
  });

  it("reconstructs gross counts even at this size", () => {
    expect(s.movedAdded + s.residualAdded + s.newLines).toBe(s.grossAdded);
    expect(s.movedRemoved + s.residualRemoved + s.deletedLines).toBe(s.grossRemoved);
  });
});
