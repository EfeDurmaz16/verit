/**
 * The whole dashboard schema. Every statement is idempotent, so `pnpm migrate`
 * is safe to run against a fresh Neon branch or an existing one.
 *
 * Postgres here, not SQLite: the hosted deployment is serverless and many
 * runners write runs at once. Ids stay text and match the ids the pipeline
 * already produces, so a row can always be traced back to a run in the logs.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repos (
  id                 text PRIMARY KEY,
  owner              text NOT NULL,
  name               text NOT NULL,
  ingest_token_hash  text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id             text PRIMARY KEY,
  repo_id        text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number      integer,
  pr_title       text,
  pr_url         text,
  pr_author      text,
  head_sha       text,
  domain         text NOT NULL,
  focus          text,
  verdict        text NOT NULL,
  proof_status   text NOT NULL,
  proof_command  text,
  proof_source   text,
  exit_code      integer,
  duration_ms    integer,
  timed_out      boolean NOT NULL DEFAULT false,
  log_tail       text,
  log_keys       text[] NOT NULL DEFAULT '{}',
  understanding  jsonb NOT NULL,
  proof_spec     jsonb NOT NULL,
  created_at     timestamptz NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runs_repo_created ON runs (repo_id, created_at DESC);

-- Answers to "may this GitHub user read this repo", cached with a TTL so a
-- page view does not cost a GitHub API call. Never a grant of its own: an
-- entry past its TTL is re-checked against GitHub before it is trusted.
CREATE TABLE IF NOT EXISTS repo_access (
  user_login  text NOT NULL,
  repo_id     text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  can_read    boolean NOT NULL,
  checked_at  timestamptz NOT NULL,
  PRIMARY KEY (user_login, repo_id)
);

-- ---------------------------------------------------------------------------
-- Ontology v0: durable per-repo learnings, every row tied to a real run.
-- A competitor's "memory" is unverified. Here, a decision cites the run that
-- produced it, a risk closes only against a later proof or CI outcome, and a
-- proof profile is aggregated from per-run facts, never a hand-kept number.
-- All additive to the tables above; the migration stays idempotent.
-- ---------------------------------------------------------------------------

-- What a PR changed and why, lifted from its run Understanding, with the files
-- and symbols it touched so a later overlapping PR can find it. run_id is the
-- idempotency key: a retried upload lands on the same row. merged_at is null
-- until a real merge signal fills it, so continuity never treats an open PR as
-- settled history.
CREATE TABLE IF NOT EXISTS decision_log (
  run_id          text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  repo_id         text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number       integer,
  pr_author       text,
  pr_title        text,
  head_sha        text,
  what            text NOT NULL,
  why             text NOT NULL,
  touched_paths   text[] NOT NULL DEFAULT '{}',
  touched_symbols text[] NOT NULL DEFAULT '{}',
  refs            integer[] NOT NULL DEFAULT '{}',
  proof_verdict   text NOT NULL,
  merged_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decision_log_repo_author ON decision_log (repo_id, pr_author);

-- A declared or found risk and its lifecycle. status is open, confirmed, or
-- refuted. A later run that materialises the risk (its proof failed) confirms
-- it; one that proves the area safe (proof passed) refutes it. ord makes the
-- key unique when one run declares two risks with the same area slug.
CREATE TABLE IF NOT EXISTS risk_ledger (
  run_id        text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ord           integer NOT NULL,
  repo_id       text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number     integer,
  area          text NOT NULL,
  note          text NOT NULL,
  source        text,
  status        text NOT NULL DEFAULT 'open',
  closed_by_run text REFERENCES runs(id) ON DELETE SET NULL,
  closed_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ord)
);
CREATE INDEX IF NOT EXISTS risk_ledger_repo_status ON risk_ledger (repo_id, status);

-- One proof fact per run. ProofProfile (per repo and command: pass rate and
-- flakiness) is AGGREGATED from these rows, never stored as a running counter:
-- re-posting a run id overwrites its own row, so the aggregate can never
-- double-count a retried upload.
CREATE TABLE IF NOT EXISTS proof_observation (
  run_id       text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  repo_id      text NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  command      text NOT NULL,
  source       text,
  ok           boolean NOT NULL,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proof_observation_repo_cmd ON proof_observation (repo_id, command);
`;
