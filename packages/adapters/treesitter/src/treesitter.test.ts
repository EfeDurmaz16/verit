import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeTreeSitterParser } from "./index";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const parser = makeTreeSitterParser();

const extract = (file: string) =>
  Effect.runPromise(
    parser.extractSymbols(file, readFileSync(join(fixturesDir, file), "utf8")),
  );

const byName = (
  syms: readonly { name: string; kind: string; startLine: number; endLine: number }[],
  name: string,
  kind: string,
) => syms.find((s) => s.name === name && s.kind === kind);

describe("tree-sitter parser", () => {
  it("extracts typescript symbols with ranges", async () => {
    const syms = await extract("sample.ts");
    expect(byName(syms, "node:fs", "import")).toBeDefined();
    const fn = byName(syms, "payGate", "function");
    expect(fn).toMatchObject({ startLine: 3, endLine: 5 });
    const cls = byName(syms, "Ledger", "class");
    expect(cls).toMatchObject({ startLine: 7, endLine: 11 });
    expect(byName(syms, "post", "method")).toMatchObject({ startLine: 8, endLine: 10 });
    expect(byName(syms, "Entry", "interface")).toBeDefined();
    expect(byName(syms, "Cents", "type")).toBeDefined();
    expect(byName(syms, "LIMIT", "const")).toBeDefined();
    expect(byName(syms, "payGate", "export")).toBeDefined();
  });

  it("extracts tsx symbols", async () => {
    const syms = await extract("sample.tsx");
    expect(byName(syms, "react", "import")).toBeDefined();
    expect(byName(syms, "App", "function")).toBeDefined();
    expect(byName(syms, "Panel", "const")).toBeDefined();
  });

  it("extracts javascript symbols", async () => {
    const syms = await extract("sample.js");
    expect(byName(syms, "node:path", "import")).toBeDefined();
    expect(byName(syms, "add", "function")).toBeDefined();
    expect(byName(syms, "Queue", "class")).toBeDefined();
    expect(byName(syms, "push", "method")).toBeDefined();
  });

  it("extracts python symbols, methods separate from functions", async () => {
    const syms = await extract("sample.py");
    expect(byName(syms, "os", "import")).toBeDefined();
    expect(byName(syms, "collections", "import")).toBeDefined();
    expect(byName(syms, "Ledger", "class")).toMatchObject({ startLine: 5, endLine: 8 });
    expect(byName(syms, "post", "method")).toBeDefined();
    expect(byName(syms, "audit", "function")).toMatchObject({ startLine: 11, endLine: 12 });
  });

  it("extracts rust symbols, impl and trait fns as methods", async () => {
    const syms = await extract("sample.rs");
    expect(byName(syms, "std::io::Read", "import")).toBeDefined();
    expect(byName(syms, "Ledger", "struct")).toBeDefined();
    expect(byName(syms, "post", "method")).toMatchObject({ startLine: 8, endLine: 10 });
    expect(byName(syms, "Audit", "trait")).toBeDefined();
    expect(byName(syms, "check", "method")).toBeDefined();
    expect(byName(syms, "audit", "function")).toBeDefined();
  });

  it("extracts go symbols, receiver funcs as methods", async () => {
    const syms = await extract("sample.go");
    expect(byName(syms, "fmt", "import")).toBeDefined();
    expect(byName(syms, "Ledger", "type")).toBeDefined();
    expect(byName(syms, "Post", "method")).toMatchObject({ startLine: 9, endLine: 11 });
    expect(byName(syms, "Audit", "function")).toBeDefined();
  });

  it("falls back to the regex parser for unsupported extensions", async () => {
    const syms = await extract("sample.foo");
    // The regex fallback tags everything "symbol"; tree-sitter never does.
    expect(syms).toEqual([
      { name: "fallbackHit", kind: "symbol", startLine: 1, endLine: 1 },
    ]);
  });
});
