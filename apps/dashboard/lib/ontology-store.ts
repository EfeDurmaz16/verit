/**
 * Postgres persistence for the ontology. Every function here is a thin adapter:
 * it computes rows with the pure logic in ./ontology and reads or writes them.
 * All the interesting decisions live there and are tested without a database.
 */
import type { RunUpload } from "@verit/domain";
import { query } from "./db";
import {
  deriveDecision,
  deriveObservation,
  deriveRisks,
  type Decision,
  type LedgerRisk,
  type OntologySnapshot,
  type ProofObservation,
  resolveRisks,
} from "./ontology";

interface DecisionRow {
  run_id: string;
  repo_id: string;
  pr_number: number | null;
  pr_author: string | null;
  pr_title: string | null;
  head_sha: string | null;
  what: string;
  why: string;
  touched_paths: string[];
  touched_symbols: string[];
  refs: number[];
  proof_verdict: string;
  merged_at: Date | null;
  created_at: Date;
}

interface RiskRow {
  run_id: string;
  ord: number;
  repo_id: string;
  pr_number: number | null;
  area: string;
  note: string;
  source: string | null;
  status: string;
  closed_by_run: string | null;
  closed_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ObservationRow {
  run_id: string;
  repo_id: string;
  command: string;
  source: string | null;
  ok: boolean;
  duration_ms: number | null;
  created_at: Date;
}

const toDecision = (r: DecisionRow): Decision => ({
  runId: r.run_id,
  repoId: r.repo_id,
  prNumber: r.pr_number,
  prAuthor: r.pr_author,
  prTitle: r.pr_title,
  headSha: r.head_sha,
  what: r.what,
  why: r.why,
  touchedPaths: r.touched_paths,
  touchedSymbols: r.touched_symbols,
  refs: r.refs,
  proofVerdict: r.proof_verdict as Decision["proofVerdict"],
  mergedAt: r.merged_at ? r.merged_at.toISOString() : null,
  createdAt: r.created_at.toISOString(),
});

const toRisk = (r: RiskRow): LedgerRisk => ({
  runId: r.run_id,
  ord: r.ord,
  repoId: r.repo_id,
  prNumber: r.pr_number,
  area: r.area,
  note: r.note,
  source: r.source,
  status: r.status as LedgerRisk["status"],
  closedByRun: r.closed_by_run,
  closedReason: r.closed_reason,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toObservation = (r: ObservationRow): ProofObservation => ({
  runId: r.run_id,
  repoId: r.repo_id,
  command: r.command,
  source: r.source,
  ok: r.ok,
  durationMs: r.duration_ms,
  createdAt: r.created_at.toISOString(),
});

/**
 * Populate the ontology from one uploaded run. Runs after saveRun, so the run
 * row the FKs point at already exists. Idempotent on the run id: a retried
 * upload overwrites its own decision, risks, and observation, then re-runs the
 * risk-closing pass. Never increments a stored counter.
 */
export const recordRunOntology = async (u: RunUpload): Promise<void> => {
  const now = new Date().toISOString();
  const decision = deriveDecision(u, now);
  const risks = deriveRisks(u, now);
  const obs = deriveObservation(u, now);

  await query(
    `INSERT INTO decision_log (
       run_id, repo_id, pr_number, pr_author, pr_title, head_sha, what, why,
       touched_paths, touched_symbols, refs, proof_verdict, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (run_id) DO UPDATE SET
       pr_number=excluded.pr_number, pr_author=excluded.pr_author,
       pr_title=excluded.pr_title, head_sha=excluded.head_sha, what=excluded.what,
       why=excluded.why, touched_paths=excluded.touched_paths,
       touched_symbols=excluded.touched_symbols, refs=excluded.refs,
       proof_verdict=excluded.proof_verdict`,
    [
      decision.runId, decision.repoId, decision.prNumber, decision.prAuthor,
      decision.prTitle, decision.headSha, decision.what, decision.why,
      decision.touchedPaths, decision.touchedSymbols, decision.refs,
      decision.proofVerdict, decision.createdAt,
    ],
  );

  // Upsert each risk by (run_id, ord) so a closed risk keeps its status on a
  // re-post, then drop any surplus rows a shorter re-post left behind.
  for (const r of risks) {
    await query(
      `INSERT INTO risk_ledger (
         run_id, ord, repo_id, pr_number, area, note, source, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$8)
       ON CONFLICT (run_id, ord) DO UPDATE SET
         pr_number=excluded.pr_number, area=excluded.area, note=excluded.note,
         source=excluded.source`,
      [r.runId, r.ord, r.repoId, r.prNumber, r.area, r.note, r.source, r.createdAt],
    );
  }
  await query(`DELETE FROM risk_ledger WHERE run_id = $1 AND ord >= $2`, [
    u.run.id,
    risks.length,
  ]);

  if (obs) {
    await query(
      `INSERT INTO proof_observation (run_id, repo_id, command, source, ok, duration_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET
         command=excluded.command, source=excluded.source, ok=excluded.ok,
         duration_ms=excluded.duration_ms`,
      [obs.runId, obs.repoId, obs.command, obs.source, obs.ok, obs.durationMs, obs.createdAt],
    );
  }

  // Close open risks this run confirms or refutes.
  const open = await loadOpenRisks(u.repo);
  const closed = resolveRisks(
    open,
    {
      runId: decision.runId,
      refs: decision.refs,
      touchedPaths: decision.touchedPaths,
      proofVerdict: decision.proofVerdict,
    },
    now,
  );
  for (const r of closed) {
    await query(
      `UPDATE risk_ledger SET status=$1, closed_by_run=$2, closed_reason=$3, updated_at=$4
       WHERE run_id=$5 AND ord=$6`,
      [r.status, r.closedByRun, r.closedReason, r.updatedAt, r.runId, r.ord],
    );
  }
};

export const loadOpenRisks = async (repoId: string): Promise<LedgerRisk[]> =>
  (
    await query<RiskRow>(
      `SELECT * FROM risk_ledger WHERE repo_id = $1 AND status = 'open' ORDER BY created_at`,
      [repoId],
    )
  ).map(toRisk);

/** The whole ontology of one repo, for the continuity pack and the export. */
export const loadOntologySnapshot = async (repoId: string): Promise<OntologySnapshot> => {
  const [decisions, risks, observations] = await Promise.all([
    query<DecisionRow>(
      `SELECT * FROM decision_log WHERE repo_id = $1 ORDER BY created_at, run_id`,
      [repoId],
    ),
    query<RiskRow>(
      `SELECT * FROM risk_ledger WHERE repo_id = $1 ORDER BY run_id, ord`,
      [repoId],
    ),
    query<ObservationRow>(
      `SELECT * FROM proof_observation WHERE repo_id = $1 ORDER BY created_at, run_id`,
      [repoId],
    ),
  ]);
  return {
    repoId,
    decisions: decisions.map(toDecision),
    risks: risks.map(toRisk),
    observations: observations.map(toObservation),
  };
};

/** Record a real merge so continuity may treat this PR's decision as history. */
export const markDecisionMerged = async (
  repoId: string,
  prNumber: number,
  mergedAt: string,
): Promise<void> => {
  await query(
    `UPDATE decision_log SET merged_at = $1 WHERE repo_id = $2 AND pr_number = $3`,
    [mergedAt, repoId, prNumber],
  );
};
