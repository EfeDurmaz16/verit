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

-- A revoked repo can no longer ingest, even with its right token. Distinct
-- from reissue: revoke stops uploads without minting a new secret, and
-- register-repo clears it again by issuing a fresh token.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

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
`;
