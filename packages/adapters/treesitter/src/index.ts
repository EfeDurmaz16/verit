import { Effect } from "effect";
import type { ParserPort } from "@cyclops/ports";
import { makeRegexParser } from "@cyclops/adapter-memory";

/**
 * tree-sitter when WASM grammars are configured; falls back to deterministic regex parser.
 * Grammars can be added under assets/ later (typescript, go, rust).
 */
export const makeTreeSitterParser = (): ParserPort => {
  // Full web-tree-sitter init needs grammar WASM files in-repo; ship regex baseline now
  // and keep this module as the ParserPort seam for grammar upgrades.
  const fallback = makeRegexParser();
  return {
    extractSymbols: (path, source) =>
      Effect.gen(function* () {
        // Placeholder hook for Parser.init() + Language.load(...)
        return yield* fallback.extractSymbols(path, source);
      }),
  };
};

export { makeRegexParser };
