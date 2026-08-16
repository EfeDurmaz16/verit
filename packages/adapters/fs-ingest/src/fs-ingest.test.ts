import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { FileNode, IndexChunk, SymbolNode, WikiPage } from "@verit/domain";
import type { DocumentStore, GraphStore, ParserPort } from "@verit/ports";
import { ingestRepoPath } from "./index";

/* Inline fakes: the test only needs to see what ingest writes, not a real DB. */
const fakeGraph = () => {
  const files: FileNode[] = [];
  const symbols: SymbolNode[] = [];
  const wiki: WikiPage[] = [];
  const graph: GraphStore = {
    upsertRepo: () => Effect.void,
    upsertFile: (f) => Effect.sync(() => void files.push(f)),
    upsertSymbol: (s) => Effect.sync(() => void symbols.push(s)),
    upsertWikiPage: (w) => Effect.sync(() => void wiki.push(w)),
    upsertPullRequest: () => Effect.void,
    upsertPREdge: () => Effect.void,
    listWikiPages: () => Effect.succeed(wiki),
    listPREdges: () => Effect.succeed([]),
    getPullRequest: () => Effect.succeed(null),
    listPullRequests: () => Effect.succeed([]),
    linkRunToPr: () => Effect.void,
  };
  return { graph, files, symbols, wiki };
};

const fakeDocs = () => {
  const chunks: IndexChunk[] = [];
  const docs: DocumentStore = {
    upsertReviewRun: () => Effect.void,
    getReviewRun: () => Effect.succeed(null),
    upsertProofArtifact: () => Effect.void,
    listProofArtifacts: () => Effect.succeed([]),
    upsertChunk: (c) => Effect.sync(() => void chunks.push(c)),
    searchChunks: () => Effect.succeed([]),
    saveUnderstandingJson: () => Effect.void,
    getUnderstandingJson: () => Effect.succeed(null),
  };
  return { docs, chunks };
};

const oneSymbolParser: ParserPort = {
  extractSymbols: (path) =>
    Effect.succeed(
      path.endsWith(".ts")
        ? [{ name: "main", kind: "function", startLine: 1, endLine: 3 }]
        : [],
    ),
};

describe("ingestRepoPath", () => {
  it("indexes files, symbols, wiki pages and chunks, skipping ignored dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "verit-ingest-"));
    await writeFile(join(root, "README.md"), "# Title\n\nIntro text.\n\n## Usage\n\nRun it.\n");
    await writeFile(join(root, "main.ts"), "export function main() {\n  return 1;\n}\n");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.ts"), "export const hidden = 1;\n");
    await mkdir(join(root, ".data"));
    await writeFile(join(root, ".data", "junk.md"), "# never indexed\n");

    const { graph, files, symbols } = fakeGraph();
    const { docs, chunks } = fakeDocs();
    const result = await Effect.runPromise(
      ingestRepoPath(graph, oneSymbolParser, "repo:local/x", root, docs),
    );

    // node_modules and .data never reach the index
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "main.ts"]);
    expect(result.files).toBe(2);

    // markdown became wiki pages and searchable chunks
    expect(result.wikiPages).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => c.sourceKind === "wiki" && c.text.includes("Intro"))).toBe(true);

    // code produced a symbol and file chunks
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toMatchObject({ name: "main", kind: "function" });
    expect(chunks.some((c) => c.sourceKind === "file" && c.text.includes("function main"))).toBe(
      true,
    );
    expect(result.chunks).toBe(chunks.length);
  });
});
