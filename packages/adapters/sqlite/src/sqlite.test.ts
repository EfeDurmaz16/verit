import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  normalizeDecision,
  normalizeExecutionMemory,
  normalizeOutcome,
} from "@verit/domain";
import {
  makeSqliteCorpusStore,
  makeSqliteDocumentStore,
  makeSqliteStores,
  migrateSqlite,
} from "./index";

describe("sqlite document store", () => {
  it("persists run + understanding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verit-"));
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

  it("treats an invalid stored understanding as absent, not as trusted data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verit-bad-"));
    const path = join(dir, "t.db");
    const store = makeSqliteDocumentStore(path);
    await Effect.runPromise(
      store.upsertReviewRun({
        id: "run:bad",
        repoId: "r",
        skillPackHash: "abc",
        domain: "GENERAL",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    // corrupt the row behind the store's back: schema-invalid and non-JSON
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE review_runs SET understanding_json = ? WHERE id = ?`).run(
      JSON.stringify({ what: "w" }),
      "run:bad",
    );
    expect(await Effect.runPromise(store.getUnderstandingJson("run:bad"))).toBeNull();
    db.prepare(`UPDATE review_runs SET understanding_json = ? WHERE id = ?`).run(
      "not json at all",
      "run:bad",
    );
    expect(await Effect.runPromise(store.getUnderstandingJson("run:bad"))).toBeNull();
  });

  it("indexes chunks with FTS retrieval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verit-fts-"));
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
    const dir = mkdtempSync(join(tmpdir(), "verit-sess-"));
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

describe("the corpus store remembers facts and forgets on request", () => {
  const AT = "2026-08-30T00:00:00.000Z";
  const open = () => {
    const db = new DatabaseSync(":memory:");
    migrateSqlite(db);
    return { db, corpus: makeSqliteCorpusStore(db) };
  };

  it("recalls the last install that worked for a dependency set", async () => {
    const { corpus } = open();
    await Effect.runPromise(
      corpus.recordExecutionMemory(
        normalizeExecutionMemory({
          repoId: "r1",
          dependencyDigest: "dep-a",
          installCommand: "pnpm install --frozen-lockfile",
          installOutcome: "ok",
          installMillis: 4000,
          observedAt: AT,
        }),
      ),
    );
    await Effect.runPromise(
      corpus.recordExecutionMemory(
        normalizeExecutionMemory({
          repoId: "r1",
          dependencyDigest: "dep-a",
          installCommand: "npm ci",
          installOutcome: "failed",
          observedAt: "2026-08-31T00:00:00.000Z",
        }),
      ),
    );
    const found = await Effect.runPromise(corpus.lastGoodInstall("r1", "dep-a"));
    expect(found?.installCommand).toBe("pnpm install --frozen-lockfile");
  });

  it("returns nothing for a dependency set it has never seen", async () => {
    const { corpus } = open();
    expect(await Effect.runPromise(corpus.lastGoodInstall("r1", "unknown"))).toBeNull();
  });

  it("counts how often a probe disagreed with itself", async () => {
    const { corpus } = open();
    const record = (stable: boolean, at: string) =>
      corpus.recordOutcome(
        normalizeOutcome({
          repoId: "r1",
          probeHash: "h1",
          probeOrigin: "repo-native",
          baseState: "pass",
          headState: "fail",
          classification: stable ? "regression" : "inconclusive",
          runsPerSide: 2,
          stable,
          observedAt: at,
        }),
      );
    await Effect.runPromise(record(true, AT));
    await Effect.runPromise(record(false, "2026-08-31T00:00:00.000Z"));
    await Effect.runPromise(record(false, "2026-09-01T00:00:00.000Z"));
    expect(await Effect.runPromise(corpus.probeStability("r1", "h1"))).toEqual({
      runs: 3,
      unstable: 2,
    });
  });

  it("exports and then deletes everything for one repository, and nothing else", async () => {
    const { corpus } = open();
    await Effect.runPromise(
      corpus.recordExecutionMemory(normalizeExecutionMemory({ repoId: "r1", observedAt: AT })),
    );
    await Effect.runPromise(
      corpus.recordExecutionMemory(normalizeExecutionMemory({ repoId: "r2", observedAt: AT })),
    );
    await Effect.runPromise(
      corpus.recordDecision(
        normalizeDecision({
          repoId: "r1",
          probeHash: "h1",
          classification: "regression",
          disposition: "accepted",
          readiness: "proof-ready",
          observedAt: AT,
        }),
      ),
    );

    const exported = await Effect.runPromise(corpus.exportRepo("r1"));
    expect(exported.execution).toHaveLength(1);
    expect(exported.decisions[0]?.disposition).toBe("accepted");

    const removed = await Effect.runPromise(corpus.deleteRepo("r1"));
    expect(removed).toBe(2);
    expect((await Effect.runPromise(corpus.exportRepo("r1"))).execution).toHaveLength(0);
    expect((await Effect.runPromise(corpus.exportRepo("r2"))).execution).toHaveLength(1);
  });
});
