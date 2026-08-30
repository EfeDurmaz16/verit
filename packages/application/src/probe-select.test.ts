import type { Claim } from "@verit/domain";
import type { ProveCommand } from "@verit/ports";
import { describe, expect, it } from "vitest";
import { looksLikeTest, scopeRunnerToFile, selectRepoNativeProbes } from "./probe-select";

const claim = (id: string, regions: readonly string[]): Claim => ({
  id,
  statement: `claim ${id}`,
  state: "source-grounded",
  anchors: [{ kind: "diff", ref: regions[0] ?? "x", span: "changed" }],
  modelConfidence: 0.5,
  regions: [...regions],
});

describe("looksLikeTest", () => {
  const yes = [
    "src/parse.test.ts",
    "src/parse.spec.ts",
    "pkg/parse_test.go",
    "tests/test_parse.py",
    "src/__tests__/parse.ts",
    "test/parse.rb",
    "spec/parse_spec.rb",
  ];
  const no = ["src/parse.ts", "src/latest.ts", "lib/contest.js", "README.md"];
  for (const p of yes) it(`counts ${p}`, () => expect(looksLikeTest(p)).toBe(true));
  for (const p of no) it(`does not count ${p}`, () => expect(looksLikeTest(p)).toBe(false));
});

describe("selectRepoNativeProbes asks the repository before generating anything", () => {
  const repoFiles = [
    "src/parse.ts",
    "src/parse.test.ts",
    "src/upload.ts",
    "src/__tests__/upload.test.ts",
    "src/unrelated.test.ts",
    "README.md",
  ];

  it("picks a test that references the changed file", () => {
    const picked = selectRepoNativeProbes({
      claims: [claim("c1", ["src/upload.ts"])],
      repoFiles,
      referencesOf: (t) => (t === "src/unrelated.test.ts" ? ["src/upload.ts"] : []),
    });
    const byPath = new Map(picked.map((p) => [p.path, p]));
    expect(byPath.get("src/unrelated.test.ts")?.reason).toBe("references src/upload.ts");
  });

  it("picks a conventionally named sibling and says the signal is weaker", () => {
    const picked = selectRepoNativeProbes({
      claims: [claim("c1", ["src/parse.ts"])],
      repoFiles,
    });
    const parse = picked.find((p) => p.path === "src/parse.test.ts");
    expect(parse).toBeDefined();
    expect(parse?.reason).toContain("by convention");
  });

  it("prefers the reference over the naming convention for the same file", () => {
    const picked = selectRepoNativeProbes({
      claims: [claim("c1", ["src/parse.ts"])],
      repoFiles,
      referencesOf: (t) => (t === "src/parse.test.ts" ? ["src/parse.ts"] : []),
    });
    expect(picked.find((p) => p.path === "src/parse.test.ts")?.reason).toBe(
      "references src/parse.ts",
    );
  });

  it("returns nothing rather than guessing when no test relates", () => {
    const picked = selectRepoNativeProbes({
      claims: [claim("c1", ["src/brand-new.ts"])],
      repoFiles,
    });
    expect(picked).toEqual([]);
  });

  it("keeps a test the change itself edits", () => {
    const picked = selectRepoNativeProbes({
      claims: [claim("c1", ["src/parse.test.ts"])],
      repoFiles,
    });
    expect(picked[0]?.path).toBe("src/parse.test.ts");
    expect(picked[0]?.reason).toBe("the change edits this test");
  });

  it("carries every claim a test speaks to", () => {
    const picked = selectRepoNativeProbes({
      claims: [claim("c1", ["src/parse.ts"]), claim("c2", ["src/parse.ts"])],
      repoFiles,
    });
    expect([...(picked.find((p) => p.path === "src/parse.test.ts")?.claimIds ?? [])].sort()).toEqual([
      "c1",
      "c2",
    ]);
  });
});

describe("scopeRunnerToFile narrows a suite, or admits it cannot", () => {
  const cmd = (command: string, args: readonly string[]): ProveCommand => ({
    command,
    args: [...args],
    source: "test",
  });

  it("appends the path for a runner that takes one positionally", () => {
    const out = scopeRunnerToFile(cmd("npx", ["vitest", "run"]), "src/parse.test.ts");
    expect(out?.args).toEqual(["vitest", "run", "src/parse.test.ts"]);
  });

  it("passes the path through the separator for a package script", () => {
    const out = scopeRunnerToFile(cmd("pnpm", ["test"]), "src/parse.test.ts");
    expect(out?.args).toEqual(["test", "--", "src/parse.test.ts"]);
  });

  it("does not add a separator for yarn, which does not want one", () => {
    const out = scopeRunnerToFile(cmd("yarn", ["test"]), "src/parse.test.ts");
    expect(out?.args).toEqual(["test", "src/parse.test.ts"]);
  });

  it("scopes go to the package, because go test does not take a file", () => {
    const out = scopeRunnerToFile(cmd("go", ["test", "./..."]), "pkg/parse_test.go");
    expect(out?.args).toEqual(["test", "./pkg/..."]);
  });

  it("returns null rather than guessing a flag it does not know", () => {
    expect(scopeRunnerToFile(cmd("make", ["test"]), "src/parse.test.ts")).toBeNull();
    expect(scopeRunnerToFile(cmd("cargo", ["test"]), "src/lib.rs")).toBeNull();
  });
});
