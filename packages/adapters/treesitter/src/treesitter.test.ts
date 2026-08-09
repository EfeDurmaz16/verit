import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeTreeSitterParser } from "./index";

describe("treesitter parser seam", () => {
  it("extracts ts function names", async () => {
    const p = makeTreeSitterParser();
    const syms = await Effect.runPromise(
      p.extractSymbols(
        "a.ts",
        "export function payGate() {}\nconst x = 1;\nexport class Foo {}\n",
      ),
    );
    expect(syms.some((s) => s.name === "payGate")).toBe(true);
    expect(syms.some((s) => s.name === "Foo")).toBe(true);
  });
});
