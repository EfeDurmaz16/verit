import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Either } from "effect";
import { decodeUnderstanding } from "@verit/domain";
import type {
  DecisionRecord,
  ExecutionMemoryRecord,
  IndexChunk,
  OutcomeRecord,
  ProofArtifact,
  ReviewRun,
  WorkspaceRun,
} from "@verit/domain";
import type { CorpusStore, DocumentStore, SessionStore } from "@verit/ports";
import { StoreError } from "@verit/ports";

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
    CREATE TABLE IF NOT EXISTS corpus_execution (
      repo_id TEXT NOT NULL,
      toolchain_digest TEXT NOT NULL,
      dependency_digest TEXT NOT NULL,
      install_command TEXT NOT NULL,
      install_outcome TEXT NOT NULL,
      install_millis INTEGER NOT NULL,
      policy_digest TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS corpus_outcomes (
      repo_id TEXT NOT NULL,
      probe_hash TEXT NOT NULL,
      probe_origin TEXT NOT NULL,
      base_state TEXT NOT NULL,
      head_state TEXT NOT NULL,
      classification TEXT NOT NULL,
      grade TEXT,
      runs_per_side INTEGER NOT NULL,
      stable INTEGER NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS corpus_decisions (
      repo_id TEXT NOT NULL,
      probe_hash TEXT NOT NULL,
      classification TEXT NOT NULL,
      grade TEXT,
      disposition TEXT NOT NULL,
      readiness TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proof_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_type TEXT NOT NULL,
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_sessions (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      workdir TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT,
      review_run_id TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS workspace_runs_session
      ON workspace_runs (session_id, started_at DESC);
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

const openDb = (filename: string): DatabaseSync => {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  migrateSqlite(db);
  return db;
};

const wrapOn =
  (label: string) =>
  <A>(fn: () => A) =>
    Effect.try({ try: fn, catch: (e) => new StoreError(label, e) });

/** Both stores over one connection: sessions and their ReviewRuns share a DB. */
export const makeSqliteStores = (
  filename: string,
): { docs: DocumentStore; sessions: SessionStore } => {
  const db = openDb(filename);
  return { docs: documentStoreOn(db), sessions: sessionStoreOn(db) };
};

export const makeSqliteDocumentStore = (filename: string): DocumentStore =>
  documentStoreOn(openDb(filename));

const sessionStoreOn = (db: DatabaseSync): SessionStore => {
  const wrap = wrapOn("sqlite sessions");
  const toRun = (row: Record<string, unknown>): WorkspaceRun => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    status: row.status as WorkspaceRun["status"],
    threadId: row.thread_id == null ? null : String(row.thread_id),
    reviewRunId: row.review_run_id == null ? null : String(row.review_run_id),
    error: row.error == null ? null : String(row.error),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
  });

  return {
    upsertSession: (s) =>
      wrap(() => {
        db.prepare(
          `INSERT INTO workspace_sessions (id, repo, pr_number, head_sha, workdir, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET workdir=excluded.workdir`,
        ).run(s.id, s.repo, s.prNumber, s.headSha, s.workdir, s.createdAt);
      }),
    getSession: (id) =>
      wrap(() => {
        const row = db.prepare(`SELECT * FROM workspace_sessions WHERE id = ?`).get(id) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return {
          id: String(row.id),
          repo: String(row.repo),
          prNumber: Number(row.pr_number),
          headSha: String(row.head_sha),
          workdir: String(row.workdir),
          createdAt: String(row.created_at),
        };
      }),
    upsertRun: (r) =>
      wrap(() => {
        db.prepare(
          `INSERT INTO workspace_runs
             (id, session_id, status, thread_id, review_run_id, error, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status=excluded.status,
             thread_id=excluded.thread_id,
             review_run_id=excluded.review_run_id,
             error=excluded.error,
             finished_at=excluded.finished_at`,
        ).run(
          r.id,
          r.sessionId,
          r.status,
          r.threadId,
          r.reviewRunId,
          r.error,
          r.startedAt,
          r.finishedAt,
        );
      }),
    latestRun: (sessionId) =>
      wrap(() => {
        const row = db
          .prepare(
            `SELECT * FROM workspace_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
          )
          .get(sessionId) as Record<string, unknown> | undefined;
        return row ? toRun(row) : null;
      }),
  };
};

const documentStoreOn = (db: DatabaseSync): DocumentStore => {
  const wrap = wrapOn("sqlite");

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
        // Decode on read: a stored blob is a trust boundary like any other.
        // Invalid data means the run is unverified, never a blind cast.
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.understanding_json);
        } catch {
          console.error(`[verit-sqlite] run ${runId}: stored understanding is not JSON`);
          return null;
        }
        const decoded = decodeUnderstanding(parsed);
        if (Either.isLeft(decoded)) {
          console.error(
            `[verit-sqlite] run ${runId}: stored understanding fails the schema, treating as absent`,
          );
          return null;
        }
        return decoded.right;
      }),
  };
};

/**
 * The corpus store on SQLite.
 *
 * Append only by design: a record is a thing that happened, and rewriting
 * history is how a calibration corpus starts lying to itself. Deletion is the
 * one exception and it is whole-repository, because a customer asking to be
 * forgotten means all of it.
 */
export const makeSqliteCorpusStore = (db: DatabaseSync): CorpusStore => {
  const attempt = <A>(label: string, f: () => A) =>
    Effect.try({ try: f, catch: (e) => new StoreError(label, e) });

  return {
    recordExecutionMemory: (r) =>
      attempt("corpus recordExecutionMemory", () => {
        db.prepare(
          `INSERT INTO corpus_execution
             (repo_id, toolchain_digest, dependency_digest, install_command,
              install_outcome, install_millis, policy_digest, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          r.repoId,
          r.toolchainDigest,
          r.dependencyDigest,
          r.installCommand,
          r.installOutcome,
          r.installMillis,
          r.policyDigest,
          r.observedAt,
        );
      }),

    recordOutcome: (r) =>
      attempt("corpus recordOutcome", () => {
        db.prepare(
          `INSERT INTO corpus_outcomes
             (repo_id, probe_hash, probe_origin, base_state, head_state,
              classification, grade, runs_per_side, stable, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          r.repoId,
          r.probeHash,
          r.probeOrigin,
          r.baseState,
          r.headState,
          r.classification,
          r.grade,
          r.runsPerSide,
          r.stable ? 1 : 0,
          r.observedAt,
        );
      }),

    recordDecision: (r) =>
      attempt("corpus recordDecision", () => {
        db.prepare(
          `INSERT INTO corpus_decisions
             (repo_id, probe_hash, classification, grade, disposition, readiness, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          r.repoId,
          r.probeHash,
          r.classification,
          r.grade,
          r.disposition,
          r.readiness,
          r.observedAt,
        );
      }),

    lastGoodInstall: (repoId, dependencyDigest) =>
      attempt("corpus lastGoodInstall", () => {
        const row = db
          .prepare(
            `SELECT * FROM corpus_execution
             WHERE repo_id = ? AND dependency_digest = ? AND install_outcome = 'ok'
             ORDER BY observed_at DESC LIMIT 1`,
          )
          .get(repoId, dependencyDigest) as Record<string, unknown> | undefined;
        return row === undefined ? null : rowToExecution(row);
      }),

    probeStability: (repoId, probeHash) =>
      attempt("corpus probeStability", () => {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS runs, SUM(CASE WHEN stable = 0 THEN 1 ELSE 0 END) AS unstable
             FROM corpus_outcomes WHERE repo_id = ? AND probe_hash = ?`,
          )
          .get(repoId, probeHash) as { runs?: number; unstable?: number } | undefined;
        return { runs: Number(row?.runs ?? 0), unstable: Number(row?.unstable ?? 0) };
      }),

    exportRepo: (repoId) =>
      attempt("corpus exportRepo", () => ({
        execution: (
          db.prepare("SELECT * FROM corpus_execution WHERE repo_id = ?").all(repoId) as Record<
            string,
            unknown
          >[]
        ).map(rowToExecution),
        outcomes: (
          db.prepare("SELECT * FROM corpus_outcomes WHERE repo_id = ?").all(repoId) as Record<
            string,
            unknown
          >[]
        ).map(rowToOutcome),
        decisions: (
          db.prepare("SELECT * FROM corpus_decisions WHERE repo_id = ?").all(repoId) as Record<
            string,
            unknown
          >[]
        ).map(rowToDecision),
      })),

    deleteRepo: (repoId) =>
      attempt("corpus deleteRepo", () => {
        let removed = 0;
        for (const table of ["corpus_execution", "corpus_outcomes", "corpus_decisions"]) {
          const out = db.prepare(`DELETE FROM ${table} WHERE repo_id = ?`).run(repoId);
          removed += Number(out.changes ?? 0);
        }
        return removed;
      }),
  };
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const rowToExecution = (r: Record<string, unknown>): ExecutionMemoryRecord => ({
  repoId: str(r["repo_id"]),
  toolchainDigest: str(r["toolchain_digest"]),
  dependencyDigest: str(r["dependency_digest"]),
  installCommand: str(r["install_command"]),
  installOutcome: (str(r["install_outcome"]) || "skipped") as "ok" | "failed" | "skipped",
  installMillis: Number(r["install_millis"] ?? 0),
  policyDigest: str(r["policy_digest"]),
  observedAt: str(r["observed_at"]),
});

const rowToOutcome = (r: Record<string, unknown>): OutcomeRecord => ({
  repoId: str(r["repo_id"]),
  probeHash: str(r["probe_hash"]),
  probeOrigin: (str(r["probe_origin"]) || "generated") as
    | "repo-native"
    | "generated"
    | "maintainer-supplied",
  baseState: str(r["base_state"]),
  headState: str(r["head_state"]),
  classification: str(r["classification"]),
  grade: r["grade"] === null || r["grade"] === undefined ? null : str(r["grade"]),
  runsPerSide: Number(r["runs_per_side"] ?? 1),
  stable: Number(r["stable"] ?? 0) === 1,
  observedAt: str(r["observed_at"]),
});

const rowToDecision = (r: Record<string, unknown>): DecisionRecord => ({
  repoId: str(r["repo_id"]),
  probeHash: str(r["probe_hash"]),
  classification: str(r["classification"]),
  grade: r["grade"] === null || r["grade"] === undefined ? null : str(r["grade"]),
  disposition: (str(r["disposition"]) || "unreviewed") as
    | "accepted"
    | "rejected"
    | "needs-work"
    | "unreviewed",
  readiness: str(r["readiness"]),
  observedAt: str(r["observed_at"]),
});
