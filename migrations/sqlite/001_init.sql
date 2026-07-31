-- SQLite document store schema
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
