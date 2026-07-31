import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { Effect } from "effect";
import { markdownToWikiPages, wikiPagesToChunks, chunkText } from "@cyclops/application";
import type { FileNode, SymbolNode, WikiPage } from "@cyclops/domain";
import type { DocumentStore, GraphStore, ParserPort, StoreError } from "@cyclops/ports";

const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".data", "tmp"]);

const walk = async (root: string, dir: string, out: string[]): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else out.push(full);
  }
};

export const ingestRepoPath = (
  graph: GraphStore,
  parser: ParserPort,
  repoId: string,
  root: string,
  docs?: DocumentStore,
): Effect.Effect<{ files: number; symbols: number; wikiPages: number; chunks: number }, StoreError> =>
  Effect.gen(function* () {
    const fullName = repoId.replace(/^repo:/, "");
    yield* graph.upsertRepo({ id: repoId, fullName });
    const files = yield* Effect.tryPromise({
      try: async () => {
        const all: string[] = [];
        await walk(root, root, all);
        return all;
      },
      catch: (e) => e as StoreError,
    });

    let fileCount = 0;
    let symbolCount = 0;
    let wikiCount = 0;
    let chunkCount = 0;

    for (const full of files) {
      const path = relative(root, full).replaceAll("\\", "/");
      const st = yield* Effect.tryPromise({
        try: () => stat(full),
        catch: (e) => e as StoreError,
      });
      if (st.size > 1_000_000) continue;
      const source = yield* Effect.tryPromise({
        try: () => readFile(full, "utf8"),
        catch: (e) => e as StoreError,
      });
      const fileId = `file:${repoId}:${path}`;
      const file: FileNode = {
        id: fileId,
        repoId,
        path,
        language: extname(path).slice(1) || undefined,
      };
      yield* graph.upsertFile(file);
      fileCount++;

      if (/\.(md|mdx)$/i.test(path) || path === "AGENTS.md" || path === "CONTEXT.md") {
        const pages: WikiPage[] = markdownToWikiPages(repoId, path, source);
        for (const p of pages) {
          yield* graph.upsertWikiPage(p);
          wikiCount++;
        }
        if (docs) {
          for (const c of wikiPagesToChunks(pages)) {
            yield* docs.upsertChunk(c);
            chunkCount++;
          }
        }
      }

      if (/\.(ts|tsx|js|jsx|go|rs)$/i.test(path)) {
        const syms = yield* parser.extractSymbols(path, source);
        for (const s of syms) {
          const sym: SymbolNode = {
            id: `sym:${fileId}:${s.name}:${s.startLine}`,
            fileId,
            name: s.name,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
          };
          yield* graph.upsertSymbol(sym);
          symbolCount++;
        }
        if (docs) {
          for (const c of chunkText(repoId, "file", fileId, source)) {
            yield* docs.upsertChunk(c);
            chunkCount++;
          }
        }
      }
    }

    return { files: fileCount, symbols: symbolCount, wikiPages: wikiCount, chunks: chunkCount };
  });
