import { proofVerdict, type RunUpload, type Understanding } from "@verit/domain";
import { query } from "./db";

export interface RepoRow {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly ingestTokenHash: string;
}

export interface RunSummary {
  readonly id: string;
  readonly prNumber: number | null;
  readonly prTitle: string | null;
  readonly prUrl: string | null;
  readonly headSha: string | null;
  readonly verdict: string;
  readonly proofStatus: string;
  readonly proofCommand: string | null;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

export interface RunDetail extends RunSummary {
  readonly repoId: string;
  readonly domain: string;
  readonly focus: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly proofSource: string | null;
  readonly logTail: string | null;
  readonly logKeys: readonly string[];
  readonly understanding: Understanding;
  readonly proofSpec: { root: string; elements: Record<string, unknown> };
}

const SUMMARY_COLUMNS = `
  id, pr_number, pr_title, pr_url, head_sha, verdict, proof_status,
  proof_command, duration_ms, created_at`;

interface SummaryRow {
  id: string;
  pr_number: number | null;
  pr_title: string | null;
  pr_url: string | null;
  head_sha: string | null;
  verdict: string;
  proof_status: string;
  proof_command: string | null;
  duration_ms: number | null;
  created_at: Date;
}

const toSummary = (r: SummaryRow): RunSummary => ({
  id: r.id,
  prNumber: r.pr_number,
  prTitle: r.pr_title,
  prUrl: r.pr_url,
  headSha: r.head_sha,
  verdict: r.verdict,
  proofStatus: r.proof_status,
  proofCommand: r.proof_command,
  durationMs: r.duration_ms,
  createdAt: r.created_at,
});

export const repoBySlug = async (slug: string): Promise<RepoRow | null> => {
  const rows = await query<{
    id: string;
    owner: string;
    name: string;
    ingest_token_hash: string;
  }>(`SELECT id, owner, name, ingest_token_hash FROM repos WHERE id = $1`, [slug]);
  const row = rows[0];
  return row
    ? { id: row.id, owner: row.owner, name: row.name, ingestTokenHash: row.ingest_token_hash }
    : null;
};

/** Connected repos of one org, each with the run that finished most recently. */
export const listReposForOwner = async (
  owner: string,
): Promise<Array<{ repo: RepoRow; lastRun: RunSummary | null }>> => {
  const rows = await query<
    { repo_id: string; owner: string; name: string; ingest_token_hash: string } & {
      [K in keyof SummaryRow]: SummaryRow[K] | null;
    }
  >(
    `SELECT r.id AS repo_id, r.owner, r.name, r.ingest_token_hash, last.*
       FROM repos r
       LEFT JOIN LATERAL (
         SELECT ${SUMMARY_COLUMNS} FROM runs WHERE repo_id = r.id
         ORDER BY created_at DESC LIMIT 1
       ) last ON true
      WHERE r.owner = $1
      ORDER BY r.name`,
    [owner],
  );
  return rows.map((row) => ({
    repo: {
      id: row.repo_id,
      owner: row.owner,
      name: row.name,
      ingestTokenHash: row.ingest_token_hash,
    },
    lastRun:
      row.id !== null && row.created_at !== null
        ? toSummary({
            ...row,
            id: row.id,
            created_at: row.created_at,
            verdict: row.verdict ?? "neutral",
            proof_status: row.proof_status ?? "none",
          })
        : null,
  }));
};

export const listAllRepos = async (): Promise<RepoRow[]> =>
  (
    await query<{ id: string; owner: string; name: string; ingest_token_hash: string }>(
      `SELECT id, owner, name, ingest_token_hash FROM repos ORDER BY owner, name`,
    )
  ).map((r) => ({ id: r.id, owner: r.owner, name: r.name, ingestTokenHash: r.ingest_token_hash }));

export const listOwners = async (): Promise<Array<{ owner: string; repos: number }>> =>
  (
    await query<{ owner: string; repos: string }>(
      `SELECT owner, count(*)::text AS repos FROM repos GROUP BY owner ORDER BY owner`,
    )
  ).map((r) => ({ owner: r.owner, repos: Number(r.repos) }));

export const listRuns = async (repoId: string, limit = 50): Promise<RunSummary[]> =>
  (
    await query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM runs WHERE repo_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [repoId, limit],
    )
  ).map(toSummary);

export const getRun = async (repoId: string, runId: string): Promise<RunDetail | null> => {
  const rows = await query<
    SummaryRow & {
      repo_id: string;
      domain: string;
      focus: string | null;
      exit_code: number | null;
      timed_out: boolean;
      proof_source: string | null;
      log_tail: string | null;
      log_keys: string[];
      understanding: Understanding;
      proof_spec: { root: string; elements: Record<string, unknown> };
    }
  >(`SELECT * FROM runs WHERE repo_id = $1 AND id = $2`, [repoId, runId]);
  const row = rows[0];
  if (!row) return null;
  return {
    ...toSummary(row),
    repoId: row.repo_id,
    domain: row.domain,
    focus: row.focus,
    exitCode: row.exit_code,
    timedOut: row.timed_out,
    proofSource: row.proof_source,
    logTail: row.log_tail,
    logKeys: row.log_keys,
    understanding: row.understanding,
    proofSpec: row.proof_spec,
  };
};

/**
 * Upsert on the run id. A runner that retries the upload after a timeout must
 * land on the same row instead of a duplicate, so the run id is the
 * idempotency key and re-posting the same run is a no-op that overwrites
 * itself with identical data.
 */
export const saveRun = async (
  upload: RunUpload,
  logKeys: readonly string[],
): Promise<void> => {
  const { run, prove, pr } = upload;
  await query(
    `INSERT INTO runs (
       id, repo_id, pr_number, pr_title, pr_url, pr_author, head_sha,
       domain, focus, verdict, proof_status, proof_command, proof_source,
       exit_code, duration_ms, timed_out, log_tail, log_keys,
       understanding, proof_spec, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (id) DO UPDATE SET
       pr_number=excluded.pr_number, pr_title=excluded.pr_title, pr_url=excluded.pr_url,
       pr_author=excluded.pr_author, head_sha=excluded.head_sha, domain=excluded.domain,
       focus=excluded.focus, verdict=excluded.verdict, proof_status=excluded.proof_status,
       proof_command=excluded.proof_command, proof_source=excluded.proof_source,
       exit_code=excluded.exit_code, duration_ms=excluded.duration_ms,
       timed_out=excluded.timed_out, log_tail=excluded.log_tail, log_keys=excluded.log_keys,
       understanding=excluded.understanding, proof_spec=excluded.proof_spec,
       created_at=excluded.created_at, uploaded_at=now()`,
    [
      run.id,
      upload.repo,
      pr?.number ?? null,
      pr?.title ?? null,
      pr?.url ?? null,
      pr?.author ?? null,
      pr?.headSha ?? null,
      run.domain,
      run.focus ?? null,
      proofVerdict(prove),
      prove ? (prove.exitCode === 0 ? "pass" : "fail") : "none",
      prove?.command ?? null,
      prove?.source ?? null,
      prove?.exitCode ?? null,
      prove?.durationMs ?? null,
      prove?.timedOut ?? false,
      prove?.logTail ?? null,
      logKeys,
      JSON.stringify(upload.understanding),
      JSON.stringify(upload.proofSpec),
      run.createdAt,
    ],
  );
};
