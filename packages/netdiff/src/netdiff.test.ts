import { describe, expect, it } from "vitest";
import {
  analyzeDiff,
  computeNetDiff,
  describeMoves,
  detectMoves,
  diffSection,
  netDiffChars,
  parseDiff,
  planReview,
  pairResidualLines,
  tokenDiff,
  type NetDiff,
  type TokenEdit,
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
    expect(pair?.residualPairs).toEqual([]);
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

/* --------------------- token focus inside moved blocks --------------------- */

/** The Greptile shape: a 12-line guard block moved, one line gains a 3-word check. */
const guardBlock = [
  "def validate_amount(x, limits):",
  "    if x is None:",
  '        raise ValueError("amount required")',
  "    if not isinstance(x, int):",
  '        raise TypeError("amount must be int")',
  "    lo, hi = limits",
  "    if x < lo:",
  '        raise ValueError("below minimum")',
  "    if x > hi:",
  '        raise ValueError("above maximum")',
  '    log_check("amount", x)',
  "    return x",
];
const guardEdited = guardBlock.map((l) =>
  l === "    if not isinstance(x, int):" ? "    if not isinstance(x, int) or x < 0:" : l,
);
const greptilePatch = [
  modifiedFile("src/checks.py", [editHunk(12, guardBlock, 12, [])]),
  modifiedFile("src/validators.py", [editHunk(88, [], 88, guardEdited)]),
].join("\n");

describe("move_with_edit: token focus, the Greptile shape", () => {
  it("carries exactly the changed tokens on the pair", () => {
    expect(guardBlock).toHaveLength(12);
    const moves = detectMoves(parseDiff(greptilePatch));
    expect(moves.pairs).toHaveLength(1);
    const pair = moves.pairs[0];
    expect(pair?.kind).toBe("move_with_edit");
    expect(pair?.residualPairs).toHaveLength(1);
    const rp = pair?.residualPairs[0];
    expect(rp?.removedLine).toBe("    if not isinstance(x, int):");
    expect(rp?.addedLine).toBe("    if not isinstance(x, int) or x < 0:");
    expect(rp?.edit.removedTokens).toEqual([]);
    expect(rp?.edit.addedTokens).toEqual(["or", "x", "<", "0"]);
  });

  it("renders one focus line naming the real change, under the length cap", () => {
    const net = netOf(greptilePatch);
    expect(net.regions).toHaveLength(1);
    const region = net.regions[0];
    expect(region?.kind).toBe("residual");
    expect(region?.residualPairs).toHaveLength(1);
    const focus = (region?.content ?? "")
      .split("\n")
      .filter((l) => l.startsWith("real change: "));
    expect(focus).toEqual([
      "real change: `isinstance(x, int):` -> `isinstance(x, int) or x < 0:`",
    ]);
    expect(focus[0]?.length).toBeLessThanOrEqual(125);
  });

  it("surfaces the focus line and its instruction in the shared diffSection", () => {
    const section = diffSection(greptilePatch);
    expect(section).toContain(
      "real change: `isinstance(x, int):` -> `isinstance(x, int) or x < 0:`",
    );
    expect(section).toContain("the review target");
  });

  it("keeps the gross reconstruction invariant", () => {
    const s = netOf(greptilePatch).stats;
    expect(s.movedAdded + s.residualAdded + s.newLines).toBe(s.grossAdded);
    expect(s.movedRemoved + s.residualRemoved + s.deletedLines).toBe(s.grossRemoved);
    expect(s.residualAdded).toBe(1);
    expect(s.residualRemoved).toBe(1);
  });
});

/** One 20-line block moved with two edited lines. */
const relayBlock = fn("relay", 20);
const relayEdited = relayBlock.map((l) =>
  l.includes("relay_v3")
    ? l.replace("x * 5", "x * 50")
    : l.includes("relay_v8")
      ? l.replace("x * 10", "x * 100")
      : l,
);
const multiEditPatch = [
  modifiedFile("src/relay.ts", [editHunk(4, relayBlock, 4, [])]),
  modifiedFile("src/net/relay.ts", [editHunk(30, [], 30, relayEdited)]),
].join("\n");

describe("move_with_edit: several edited lines in one block", () => {
  it("pairs each edited line with its own counterpart", () => {
    const moves = detectMoves(parseDiff(multiEditPatch));
    expect(moves.pairs).toHaveLength(1);
    const pair = moves.pairs[0];
    expect(pair?.kind).toBe("move_with_edit");
    expect(pair?.residualPairs).toHaveLength(2);
    expect(pair?.residualPairs.map((p) => p.edit.removedTokens)).toEqual([["5"], ["10"]]);
    expect(pair?.residualPairs.map((p) => p.edit.addedTokens)).toEqual([["50"], ["100"]]);
  });

  it("renders one focus line per pair, each on its own line", () => {
    const region = netOf(multiEditPatch).regions[0];
    const focus = (region?.content ?? "")
      .split("\n")
      .filter((l) => l.startsWith("real change: "));
    expect(focus).toHaveLength(2);
    expect(focus[0]).toContain("x * 5");
    expect(focus[0]).toContain("x * 50");
    expect(focus[1]).toContain("x * 10");
    expect(focus[1]).toContain("x * 100");
    for (const l of focus) expect(l.length).toBeLessThanOrEqual(125);
  });
});

describe("token focus never appears without a real edit", () => {
  it("a pure move renders no focus line anywhere", () => {
    const body = fn("quote", 12);
    const patch = [
      modifiedFile("src/pay.ts", [editHunk(10, body, 10, [])]),
      modifiedFile("src/quote.ts", [editHunk(90, [], 90, body.map((l) => `  ${l}`))]),
    ].join("\n");
    const net = netOf(patch);
    expect(net.regions).toEqual([]);
    for (const p of detectMoves(parseDiff(patch)).pairs) {
      expect(p.residualPairs).toEqual([]);
    }
  });

  it("an unmatched residual line stays a plain add with no focus line", () => {
    // the landed block gains one brand-new line unrelated to any removed line
    const landed = [...relayBlock.slice(0, 19), "  auditTrail.record(relayId, now());", ...relayBlock.slice(19)];
    const patch = [
      modifiedFile("src/relay.ts", [editHunk(4, relayBlock, 4, [])]),
      modifiedFile("src/net/relay.ts", [editHunk(30, [], 30, landed)]),
    ].join("\n");
    const moves = detectMoves(parseDiff(patch));
    const pair = moves.pairs[0];
    expect(pair?.kind).toBe("move_with_edit");
    expect(pair?.toResidual).toEqual(["  auditTrail.record(relayId, now());"]);
    expect(pair?.residualPairs).toEqual([]);
    const region = netOf(patch).regions[0];
    expect(region?.content).not.toContain("real change:");
    expect(region?.content).toContain("+  auditTrail.record(relayId, now());");
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

/* ----------------------------- token-level diff ---------------------------- */

const EMPTY_EDIT: TokenEdit = {
  removedTokens: [],
  addedTokens: [],
  beforeContext: "",
  afterContext: "",
};

describe("tokenDiff", () => {
  it("returns the empty edit for identical strings", () => {
    const line = '    raise ValueError("amount required")';
    expect(tokenDiff(line, line)).toEqual(EMPTY_EDIT);
    expect(tokenDiff("", "")).toEqual(EMPTY_EDIT);
  });

  it("treats tab and space differences as no edit at all", () => {
    expect(tokenDiff("\tif (x) {", "    if (x)  {")).toEqual(EMPTY_EDIT);
    expect(tokenDiff("a = b + c", "a=b+c")).toEqual(EMPTY_EDIT);
  });

  it("isolates a pure insertion to exactly the inserted tokens", () => {
    const edit = tokenDiff(
      "    if not isinstance(x, int):",
      "    if not isinstance(x, int) or x < 0:",
    );
    expect(edit.removedTokens).toEqual([]);
    expect(edit.addedTokens).toEqual(["or", "x", "<", "0"]);
    expect(edit.beforeContext).toBe("isinstance(x, int):");
    expect(edit.afterContext).toBe("isinstance(x, int) or x < 0:");
  });

  it("isolates a one-token replacement", () => {
    const edit = tokenDiff(
      '  const v = x * 5 + weight("charge", 3);',
      '  const v = x * 50 + weight("charge", 3);',
    );
    expect(edit.removedTokens).toEqual(["5"]);
    expect(edit.addedTokens).toEqual(["50"]);
    expect(edit.beforeContext).toContain("x * 5 +");
    expect(edit.afterContext).toContain("x * 50 +");
  });

  it("reports exact tokens across multiple changed spans in one line", () => {
    const edit = tokenDiff("foo(a, b, c)", "foo(x, b, y)");
    expect(edit.removedTokens).toEqual(["a", "c"]);
    expect(edit.addedTokens).toEqual(["x", "y"]);
    expect(edit.beforeContext).toBe("foo(a, b, c)");
    expect(edit.afterContext).toBe("foo(x, b, y)");
  });

  it("handles unicode identifiers as whole tokens", () => {
    const edit = tokenDiff(
      "toplamÜcret = hesapla(döviz)",
      "toplamÜcret = hesapla(kur)",
    );
    expect(edit.removedTokens).toEqual(["döviz"]);
    expect(edit.addedTokens).toEqual(["kur"]);
    expect(edit.afterContext).toContain("hesapla(kur)");
  });

  it("keeps original spacing in the contexts", () => {
    const edit = tokenDiff("call(a,  b)", "call(a,  c)");
    expect(edit.beforeContext).toBe("call(a,  b)");
    expect(edit.afterContext).toBe("call(a,  c)");
  });

  it("diffs against an empty line", () => {
    const edit = tokenDiff("", "return x");
    expect(edit.removedTokens).toEqual([]);
    expect(edit.addedTokens).toEqual(["return", "x"]);
    expect(edit.beforeContext).toBe("");
    expect(edit.afterContext).toBe("return x");
  });

  it("is deterministic", () => {
    const a = "if (state === OPEN && !frozen) enqueue(job);";
    const b = "if (state === OPEN && !frozen && quota(user)) enqueue(job);";
    expect(JSON.stringify(tokenDiff(a, b))).toBe(JSON.stringify(tokenDiff(a, b)));
  });
});

describe("pairResidualLines", () => {
  it("pairs the near-identical line and leaves the strangers unmatched", () => {
    const pairing = pairResidualLines(
      ["  const a = parse(x);", "  teardown();"],
      ["  const a = parseStrict(x);", "  brandNewThing(q, r, s, t);"],
    );
    expect(pairing.pairs).toHaveLength(1);
    expect(pairing.pairs[0]?.removedLine).toBe("  const a = parse(x);");
    expect(pairing.pairs[0]?.addedLine).toBe("  const a = parseStrict(x);");
    expect(pairing.pairs[0]?.edit.removedTokens).toEqual(["parse"]);
    expect(pairing.pairs[0]?.edit.addedTokens).toEqual(["parseStrict"]);
    expect(pairing.unmatchedRemoved).toEqual(["  teardown();"]);
    expect(pairing.unmatchedAdded).toEqual(["  brandNewThing(q, r, s, t);"]);
  });

  it("never pairs below the 0.5 Jaccard threshold", () => {
    const pairing = pairResidualLines(
      ["const legacy = parseCsv(row);"],
      ["let modern = decodeJson(payload).field;"],
    );
    expect(pairing.pairs).toEqual([]);
    expect(pairing.unmatchedRemoved).toHaveLength(1);
    expect(pairing.unmatchedAdded).toHaveLength(1);
  });

  it("assigns the best partner first when scores differ", () => {
    // both added lines clear the threshold against v3, but v3' scores higher
    const pairing = pairResidualLines(
      ['const relay_v3 = x * 5 + weight("relay", 3);', 'const relay_v8 = x * 10 + weight("relay", 8);'],
      ['const relay_v8 = x * 100 + weight("relay", 8);', 'const relay_v3 = x * 50 + weight("relay", 3);'],
    );
    expect(pairing.pairs.map((p) => [p.removedLine.slice(6, 14), p.addedLine.slice(6, 14)])).toEqual([
      ["relay_v3", "relay_v3"],
      ["relay_v8", "relay_v8"],
    ]);
    expect(pairing.unmatchedRemoved).toEqual([]);
    expect(pairing.unmatchedAdded).toEqual([]);
  });

  it("uses each repeated identical line exactly once, in index order", () => {
    const pairing = pairResidualLines(
      ["retry(op, 3);", "retry(op, 3);"],
      ["retry(op, 4);", "retry(op, 5);"],
    );
    expect(pairing.pairs).toHaveLength(2);
    expect(pairing.pairs[0]?.addedLine).toBe("retry(op, 4);");
    expect(pairing.pairs[1]?.addedLine).toBe("retry(op, 5);");
    expect(pairing.pairs[0]?.edit.removedTokens).toEqual(["3"]);
    expect(pairing.pairs[0]?.edit.addedTokens).toEqual(["4"]);
    expect(pairing.unmatchedRemoved).toEqual([]);
    expect(pairing.unmatchedAdded).toEqual([]);
  });

  it("handles empty sides and is deterministic", () => {
    expect(pairResidualLines([], [])).toEqual({
      pairs: [],
      unmatchedRemoved: [],
      unmatchedAdded: [],
    });
    expect(pairResidualLines(["only(removed);"], [])).toEqual({
      pairs: [],
      unmatchedRemoved: ["only(removed);"],
      unmatchedAdded: [],
    });
    const removed = ["a(1, 2);", "b(3, 4);", "a(9, 2);"];
    const added = ["a(1, 20);", "b(3, 40);", "a(9, 20);"];
    expect(JSON.stringify(pairResidualLines(removed, added))).toBe(
      JSON.stringify(pairResidualLines(removed, added)),
    );
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
  greptileGuard: greptilePatch,
  multiEditMove: multiEditPatch,
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
