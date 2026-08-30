import type { Claim } from "@verit/domain";
import { describe, expect, it } from "vitest";
import {
  type RepoIndex,
  addedPaths,
  buildSlice,
  importsFile,
  isAboutNewBehavior,
  renderSlice,
} from "./code-slice";

/*
 * The thing being tested is what a probe writer gets to read. Everything in a
 * slice has to be text that is really in the repository, and the code the claim
 * is about has to survive whatever else gets dropped.
 */

const claim = (id: string, regions: readonly string[]): Claim => ({
  id,
  statement: `claim ${id}`,
  state: "source-grounded",
  anchors: [{ kind: "diff", ref: regions[0] ?? "x", span: "changed" }],
  modelConfidence: 0.6,
  regions: [...regions],
});

const index: RepoIndex = {
  files: [
    {
      path: "src/upload.ts",
      symbols: [
        { name: "node:fs", kind: "import", startLine: 1, endLine: 1 },
        { name: "uploadRun", kind: "function", startLine: 10, endLine: 30 },
        { name: "retryOnce", kind: "function", startLine: 32, endLine: 40 },
      ],
    },
    {
      path: "src/upload.test.ts",
      symbols: [
        { name: "./upload", kind: "import", startLine: 1, endLine: 1 },
        { name: "uploadRun", kind: "function", startLine: 5, endLine: 20 },
      ],
    },
    {
      path: "src/caller.ts",
      symbols: [
        { name: "./upload", kind: "import", startLine: 1, endLine: 1 },
        { name: "uploadRun", kind: "function", startLine: 4, endLine: 9 },
      ],
    },
    {
      path: "src/unrelated.ts",
      symbols: [
        { name: "node:path", kind: "import", startLine: 1, endLine: 1 },
        { name: "somethingElse", kind: "function", startLine: 3, endLine: 8 },
      ],
    },
  ],
};

const readSpan = (path: string, s: number, e: number): string =>
  `<<${path}:${s}-${e}>>`;

const build = (over: Partial<Parameters<typeof buildSlice>[0]> = {}) =>
  buildSlice({
    claim: claim("c1", ["src/upload.ts"]),
    changedLines: new Map([["src/upload.ts", new Set([12, 13, 35])]]),
    index,
    readSpan,
    ...over,
  });

describe("a slice carries what the change can reach", () => {
  it("picks the symbols the changed lines fall inside", () => {
    const slice = build();
    expect(slice.changed.map((c) => c.symbol).sort()).toEqual(["retryOnce", "uploadRun"]);
  });

  it("leaves out a symbol no changed line touches", () => {
    const slice = build({ changedLines: new Map([["src/upload.ts", new Set([35])]]) });
    expect(slice.changed.map((c) => c.symbol)).toEqual(["retryOnce"]);
  });

  it("finds the test that imports the changed file", () => {
    expect(build().tests.map((t) => t.path)).toEqual(["src/upload.test.ts"]);
  });

  it("finds a caller and keeps it apart from the tests", () => {
    const slice = build();
    expect(slice.callers.map((c) => c.path)).toEqual(["src/caller.ts"]);
    expect(slice.callers.map((c) => c.path)).not.toContain("src/upload.test.ts");
  });

  it("leaves out a file that imports nothing of the change", () => {
    const slice = build();
    const paths = [...slice.callers, ...slice.tests].map((e) => e.path);
    expect(paths).not.toContain("src/unrelated.ts");
  });

  it("records what the touched file declares and imports", () => {
    const facts = build().files;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.declares).toEqual(["uploadRun", "retryOnce"]);
    expect(facts[0]?.imports).toEqual(["node:fs"]);
  });
});

describe("the budget never drops the code the claim is about", () => {
  it("keeps the changed symbols even when they exceed the budget", () => {
    const slice = build({ budgetChars: 1 });
    expect(slice.changed.length).toBeGreaterThan(0);
  });

  it("drops context first and says how much", () => {
    const slice = build({ budgetChars: 1 });
    expect(slice.callers).toEqual([]);
    expect(slice.truncated).toContain("left out");
  });

  it("keeps everything when the budget is generous", () => {
    const slice = build({ budgetChars: 100_000 });
    expect(slice.truncated).toBeUndefined();
    expect(slice.tests.length + slice.callers.length).toBeGreaterThan(0);
  });
});

describe("importsFile matches how a repository actually refers to a file", () => {
  const importer = {
    path: "src/x.ts",
    symbols: [
      { name: "./upload", kind: "import", startLine: 1, endLine: 1 },
      { name: "node:fs", kind: "import", startLine: 2, endLine: 2 },
    ],
  };
  it("matches a relative specifier by its stem", () => {
    expect(importsFile(importer, "src/upload.ts")).toBe(true);
  });
  it("does not match an unrelated file", () => {
    expect(importsFile(importer, "src/download.ts")).toBe(false);
  });
  it("does not match on an empty target", () => {
    expect(importsFile(importer, "")).toBe(false);
  });
});

describe("the rendered slice is repository text, not a summary", () => {
  it("names every span with its path and lines", () => {
    const text = renderSlice(build());
    expect(text).toContain("src/upload.ts:10-30 (function uploadRun)");
    expect(text).toContain("<<src/upload.ts:10-30>>");
  });

  it("separates what changed from what tests it and what calls it", () => {
    const text = renderSlice(build());
    expect(text).toContain("CODE THE CHANGE TOUCHED");
    expect(text).toContain("TESTS THAT ALREADY REACH IT");
    expect(text).toContain("CODE THAT CALLS IT");
  });

  it("says when the budget cut something, rather than looking complete", () => {
    expect(renderSlice(build({ budgetChars: 1 }))).toContain("complete as far as it goes");
  });

  it("renders nothing extra for an empty slice", () => {
    const empty = buildSlice({
      claim: claim("c9", ["nowhere.ts"]),
      changedLines: new Map(),
      index,
      readSpan,
    });
    expect(renderSlice(empty)).toBe("");
  });
});

describe("whether a claim is about new behavior comes from the diff", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/old.ts",
    "index 111..222 100644",
    "--- a/src/old.ts",
    "+++ b/src/old.ts",
    "@@ -1 +1,2 @@",
    "+const x = 1;",
    "diff --git a/src/brand-new.ts b/src/brand-new.ts",
    "new file mode 100644",
    "index 000..333",
    "--- /dev/null",
    "+++ b/src/brand-new.ts",
    "@@ -0,0 +1 @@",
    "+export const y = 2;",
  ].join("\n");

  const added = addedPaths(diff);

  it("reads the files the change created", () => {
    expect([...added]).toEqual(["src/brand-new.ts"]);
  });

  it("calls a claim about only new files new behavior", () => {
    expect(isAboutNewBehavior(["src/brand-new.ts"], added)).toBe(true);
  });

  it("does not call a claim about an existing file new behavior", () => {
    expect(isAboutNewBehavior(["src/old.ts"], added)).toBe(false);
  });

  it("is strict about a claim spanning both", () => {
    // one foot in code that already ran means the base side is not absent
    expect(isAboutNewBehavior(["src/brand-new.ts", "src/old.ts"], added)).toBe(false);
  });

  it("says no when a claim names nothing", () => {
    expect(isAboutNewBehavior([], added)).toBe(false);
  });

  it("finds nothing in a diff that creates nothing", () => {
    expect([...addedPaths("diff --git a/x b/x\n--- a/x\n+++ b/x\n+one")].length).toBe(0);
  });
});
