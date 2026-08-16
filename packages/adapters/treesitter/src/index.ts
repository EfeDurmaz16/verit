import { createRequire } from "node:module";
import { Effect } from "effect";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { ParserPort } from "@verit/ports";
import { StoreError } from "@verit/ports";
import { makeRegexParser } from "@verit/adapter-memory";

/**
 * Real tree-sitter symbol extraction over web-tree-sitter WASM.
 *
 * Grammar loading strategy: each official grammar npm package ships its own
 * prebuilt `.wasm` next to package.json. We depend on those packages and
 * resolve the wasm path with `require.resolve` at runtime. pnpm install is the
 * only fetch, so CI works offline after the store is warm. No wasm binaries
 * live in git, no build step compiles grammars, and the ignored node-gyp
 * install scripts of the grammar packages are intentional: only the wasm is
 * used.
 *
 * Files whose extension has no grammar here go to the regex fallback parser.
 */

const requireFromHere = createRequire(import.meta.url);

/** Extension to prebuilt grammar wasm shipped inside the grammar npm package. */
const GRAMMAR_WASM: Record<string, string> = {
  ts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  mts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  cts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  js: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  mjs: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  cjs: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  py: "tree-sitter-python/tree-sitter-python.wasm",
  rs: "tree-sitter-rust/tree-sitter-rust.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
};

/** Declaration node type to symbol kind, across all supported grammars. */
const DECL_KIND: Record<string, string> = {
  // typescript / tsx / javascript
  function_declaration: "function", // also go
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  // python
  function_definition: "function",
  class_definition: "class",
  // rust
  function_item: "function",
  function_signature_item: "function",
  struct_item: "struct",
  enum_item: "enum",
  trait_item: "trait",
  type_item: "type",
  const_item: "const",
  static_item: "const",
  mod_item: "module",
  // go
  method_declaration: "method",
  type_spec: "type",
};

type RawSymbol = {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
};

const span = (n: Node): { startLine: number; endLine: number } => ({
  startLine: n.startPosition.row + 1,
  endLine: n.endPosition.row + 1,
});

const stripQuotes = (s: string): string => s.replace(/^["'`]|["'`]$/g, "");

/** A function nested directly in a class body or impl/trait block is a method. */
const inMethodPosition = (n: Node): boolean => {
  const p = n.parent;
  const gp = p?.parent;
  return (
    (p?.type === "block" && gp?.type === "class_definition") ||
    (p?.type === "declaration_list" &&
      (gp?.type === "impl_item" || gp?.type === "trait_item"))
  );
};

/** Top-level (or exported top-level) const/let/var declarators become symbols. */
const isTopLevelVar = (n: Node): boolean => {
  const p = n.parent;
  return (
    p?.type === "program" ||
    (p?.type === "export_statement" && p.parent?.type === "program")
  );
};

const collect = (root: Node): RawSymbol[] => {
  const out: RawSymbol[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;

    const declKind = DECL_KIND[node.type];
    if (declKind !== undefined) {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        const kind =
          declKind === "function" && inMethodPosition(node) ? "method" : declKind;
        out.push({ name, kind, ...span(node) });
      }
    } else if (node.type === "import_statement") {
      // ts/js: field source is the module string. python: dotted_name children.
      const source = node.childForFieldName("source")?.text;
      if (source) {
        out.push({ name: stripQuotes(source), kind: "import", ...span(node) });
      } else {
        for (const c of node.namedChildren) {
          if (c && (c.type === "dotted_name" || c.type === "aliased_import")) {
            out.push({ name: c.text, kind: "import", ...span(node) });
          }
        }
      }
    } else if (node.type === "import_from_statement") {
      const mod = node.childForFieldName("module_name")?.text;
      if (mod) out.push({ name: mod, kind: "import", ...span(node) });
    } else if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument")?.text;
      if (arg) out.push({ name: arg, kind: "import", ...span(node) });
    } else if (node.type === "import_spec") {
      const path = node.childForFieldName("path")?.text;
      if (path) out.push({ name: stripQuotes(path), kind: "import", ...span(node) });
    } else if (node.type === "export_specifier") {
      const name = node.childForFieldName("name")?.text;
      if (name) out.push({ name, kind: "export", ...span(node) });
    } else if (node.type === "variable_declarator" && node.parent) {
      if (isTopLevelVar(node.parent)) {
        const name = node.childForFieldName("name");
        if (name?.type === "identifier") {
          out.push({ name: name.text, kind: "const", ...span(node) });
        }
      }
    }

    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return out;
};

let initOnce: Promise<void> | null = null;
const languageCache = new Map<string, Promise<Language>>();

const loadLanguage = (wasmSpec: string): Promise<Language> => {
  let cached = languageCache.get(wasmSpec);
  if (!cached) {
    initOnce ??= Parser.init();
    cached = initOnce.then(() => Language.load(requireFromHere.resolve(wasmSpec)));
    languageCache.set(wasmSpec, cached);
  }
  return cached;
};

const extOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
};

/**
 * tree-sitter for supported languages (ts, tsx, js, jsx, py, rs, go);
 * unsupported extensions go to the regex fallback parser.
 */
export const makeTreeSitterParser = (): ParserPort => {
  const fallback = makeRegexFallbackParser();
  let parser: Parser | null = null;
  return {
    extractSymbols: (path, source) => {
      const wasmSpec = GRAMMAR_WASM[extOf(path)];
      if (wasmSpec === undefined) return fallback.extractSymbols(path, source);
      return Effect.tryPromise({
        try: async () => {
          const language = await loadLanguage(wasmSpec);
          parser ??= new Parser();
          parser.setLanguage(language);
          const tree = parser.parse(source);
          if (!tree) throw new Error(`tree-sitter returned no tree for ${path}`);
          try {
            return collect(tree.rootNode);
          } finally {
            tree.delete();
          }
        },
        catch: (e) => new StoreError(`tree-sitter parse failed for ${path}`, e),
      });
    },
  };
};

/** The regex heuristic parser, used only when no grammar covers the file. */
export const makeRegexFallbackParser = (): ParserPort => makeRegexParser();
