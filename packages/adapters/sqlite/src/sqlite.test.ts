import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeSqliteDocumentStore } from "./index.js";

describe("sqlite document store", () => {
  it("persists run + understanding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cyclops-"));
    const store = makeSqliteDocumentStore(join(dir, "t.db"));
    await Effect.runPromise(
      store.upsertReviewRun({
        id: "run:1",
        repoId: "r",
        skillPackHash: "abc",
        domain: "GENERAL",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    await Effect.runPromise(
      store.saveUnderstandingJson("run:1", {
        what: "w",
        why: "y",
        how: "h",
        proof_refs: [],
        risks: [],
      }),
    );
    const u = await Effect.runPromise(store.getUnderstandingJson("run:1"));
    expect(u?.what).toBe("w");
  });

  it("indexes chunks with FTS retrieval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cyclops-fts-"));
    const store = makeSqliteDocumentStore(join(dir, "t.db"));
    await Effect.runPromise(
      store.upsertChunk({
        id: "chunk:1",
        repoId: "r",
        sourceKind: "wiki",
        sourceId: "wiki:1",
        text: "solana pay gate CLI token rules",
      }),
    );
    const hits = await Effect.runPromise(store.searchChunks("r", "pay", 5));
    expect(hits.some((c) => c.text.includes("pay"))).toBe(true);
  });
});
