import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import type { IndexChunk, ProofArtifact, ReviewRun, Understanding } from "@cyclops/domain";
import type { DocumentStore } from "@cyclops/ports";
import { StoreError } from "@cyclops/ports";

export const migrateSqlite = (db: DatabaseSync): void => {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS review_runs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pr_id TEXT,
      skill_pack_hash TEXT NOT NULL,
      domain TEXT NOT NULL,
      focus TEXT,
      created_at TEXT NOT NULL,
      understanding_json TEXT
    );
    CREATE TABLE IF NOT EXISTS proof_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_type TEXT NOT NULL,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_chunks (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS index_chunks_fts USING fts5(
      text,
      content='index_chunks',
      content_rowid='rowid'
    );
    CREATE TRIGGER IF NOT EXISTS index_chunks_ai AFTER INSERT ON index_chunks BEGIN
      INSERT INTO index_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS index_chunks_ad AFTER DELETE ON index_chunks BEGIN
      INSERT INTO index_chunks_fts(index_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS index_chunks_au AFTER UPDATE ON index_chunks BEGIN
      INSERT INTO index_chunks_fts(index_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO index_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
};

export const makeSqliteDocumentStore = (filename: string): DocumentStore => {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  migrateSqlite(db);

  const wrap = <A>(fn: () => A) =>
    Effect.try({
      try: fn,
      catch: (e) => new StoreError("sqlite", e),
    });

  return {
    upsertReviewRun: (run) =>
      wrap(() => {
        db.prepare(
          `INSERT INTO review_runs (id, repo_id, pr_id, skill_pack_hash, domain, focus, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             repo_id=excluded.repo_id,
             pr_id=excluded.pr_id,
             skill_pack_hash=excluded.skill_pack_hash,
             domain=excluded.domain,
             focus=excluded.focus,
             created_at=excluded.created_at`,
        ).run(
          run.id,
          run.repoId,
          run.prId ?? null,
          run.skillPackHash,
          run.domain,
          run.focus ?? null,
          run.createdAt,
        );
      }),
    getReviewRun: (id) =>
      wrap(() => {
        const row = db.prepare(`SELECT * FROM review_runs WHERE id = ?`).get(id) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return {
          id: String(row.id),
          repoId: String(row.repo_id),
          prId: row.pr_id ? String(row.pr_id) : undefined,
          skillPackHash: String(row.skill_pack_hash),
          domain: row.domain as ReviewRun["domain"],
          focus: row.focus ? (row.focus as ReviewRun["focus"]) : undefined,
          createdAt: String(row.created_at),
        };
      }),
    upsertProofArtifact: (a) =>
      wrap(() => {
        db.prepare(
          `INSERT INTO proof_artifacts (id, run_id, kind, content_type, body, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET body=excluded.body, content_hash=excluded.content_hash`,
        ).run(a.id, a.runId, a.kind, a.contentType, a.body, a.contentHash);
      }),
    listProofArtifacts: (runId) =>
      wrap(() => {
        const rows = db
          .prepare(`SELECT * FROM proof_artifacts WHERE run_id = ?`)
          .all(runId) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          id: String(row.id),
          runId: String(row.run_id),
          kind: row.kind as ProofArtifact["kind"],
          contentType: String(row.content_type),
          body: String(row.body),
          contentHash: String(row.content_hash),
        }));
      }),
    upsertChunk: (c) =>
      wrap(() => {
        db.prepare(`DELETE FROM index_chunks WHERE id = ?`).run(c.id);
        db.prepare(
          `INSERT INTO index_chunks (id, repo_id, source_kind, source_id, text)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(c.id, c.repoId, c.sourceKind, c.sourceId, c.text);
      }),
    searchChunks: (repoId, q, limit) =>
      wrap(() => {
        const needle = q.trim();
        if (!needle) return [];
        try {
          const rows = db
            .prepare(
              `SELECT c.* FROM index_chunks c
               JOIN index_chunks_fts fts ON c.rowid = fts.rowid
               WHERE c.repo_id = ? AND index_chunks_fts MATCH ?
               LIMIT ?`,
            )
            .all(repoId, needle, limit) as Array<Record<string, unknown>>;
          if (rows.length > 0) {
            return rows.map(
              (row): IndexChunk => ({
                id: String(row.id),
                repoId: String(row.repo_id),
                sourceKind: row.source_kind as IndexChunk["sourceKind"],
                sourceId: String(row.source_id),
                text: String(row.text),
              }),
            );
          }
        } catch {
          /* fall through to LIKE */
        }
        const rows = db
          .prepare(
            `SELECT * FROM index_chunks WHERE repo_id = ? AND text LIKE ? LIMIT ?`,
          )
          .all(repoId, `%${needle}%`, limit) as Array<Record<string, unknown>>;
        return rows.map(
          (row): IndexChunk => ({
            id: String(row.id),
            repoId: String(row.repo_id),
            sourceKind: row.source_kind as IndexChunk["sourceKind"],
            sourceId: String(row.source_id),
            text: String(row.text),
          }),
        );
      }),
    saveUnderstandingJson: (runId, u) =>
      wrap(() => {
        db.prepare(`UPDATE review_runs SET understanding_json = ? WHERE id = ?`).run(
          JSON.stringify(u),
          runId,
        );
      }),
    getUnderstandingJson: (runId) =>
      wrap(() => {
        const row = db
          .prepare(`SELECT understanding_json FROM review_runs WHERE id = ?`)
          .get(runId) as { understanding_json?: string } | undefined;
        if (!row?.understanding_json) return null;
        return JSON.parse(row.understanding_json) as Understanding;
      }),
  };
};
