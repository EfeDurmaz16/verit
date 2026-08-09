import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeSqliteDocumentStore, makeSqliteStores } from "./index";

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

describe("sqlite session store", () => {
  it("survives a reopen and keeps the latest run of a session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cyclops-sess-"));
    const file = join(dir, "t.db");
    const first = makeSqliteStores(file);
    await Effect.runPromise(
      first.sessions.upsertSession({
        id: "s:1",
        repo: "acme/app",
        prNumber: 7,
        headSha: "deadbeef",
        workdir: join(dir, "blobs"),
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    const base = {
      sessionId: "s:1",
      threadId: null,
      reviewRunId: null,
      error: null,
      finishedAt: null,
    } as const;
    await Effect.runPromise(
      first.sessions.upsertRun({
        ...base,
        id: "wr:1",
        status: "done",
        startedAt: "2026-01-01T00:00:00Z",
      }),
    );
    await Effect.runPromise(
      first.sessions.upsertRun({
        ...base,
        id: "wr:2",
        status: "running",
        startedAt: "2026-01-02T00:00:00Z",
      }),
    );
    // second run finishes and records the ReviewRun it produced
    await Effect.runPromise(
      first.sessions.upsertRun({
        ...base,
        id: "wr:2",
        status: "done",
        reviewRunId: "run:abc",
        startedAt: "2026-01-02T00:00:00Z",
        finishedAt: "2026-01-02T00:05:00Z",
      }),
    );

    // a fresh process would open the same file: state must come from disk
    const reopened = makeSqliteStores(file);
    const session = await Effect.runPromise(reopened.sessions.getSession("s:1"));
    expect(session?.repo).toBe("acme/app");
    const latest = await Effect.runPromise(reopened.sessions.latestRun("s:1"));
    expect(latest?.id).toBe("wr:2");
    expect(latest?.status).toBe("done");
    expect(latest?.reviewRunId).toBe("run:abc");
  });
});
