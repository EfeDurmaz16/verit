/**
 * Ontology v0. The moat seed: a per-repo memory where every row traces to a
 * real run and its proof. This module is the store-independent core, no
 * database. It decides what a run teaches (derive*), assembles a continuity
 * pack for an overlapping PR, closes risks against later proofs, and reads or
 * writes the whole thing as a single SQLite file. The Postgres wiring lives in
 * ./ontology-store and calls straight through to these functions, so all the
 * logic here is unit-testable without a live DB.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { proofVerdict, type RunUpload } from "@verit/domain";

export type ProofVerdict = "success" | "failure" | "neutral";
export type RiskStatus = "open" | "confirmed" | "refuted";

export interface Decision {
  readonly runId: string;
  readonly repoId: string;
  readonly prNumber: number | null;
  readonly prAuthor: string | null;
  readonly prTitle: string | null;
  readonly headSha: string | null;
  readonly what: string;
  readonly why: string;
  readonly touchedPaths: readonly string[];
  readonly touchedSymbols: readonly string[];
  /** PR numbers this PR explicitly references (follow-up to #N, stacked on #N). */
  readonly refs: readonly number[];
  readonly proofVerdict: ProofVerdict;
  /** Null until a real merge signal fills it. Continuity only trusts merged history. */
  readonly mergedAt: string | null;
  readonly createdAt: string;
}

export interface LedgerRisk {
  readonly runId: string;
  readonly ord: number;
  readonly repoId: string;
  readonly prNumber: number | null;
  readonly area: string;
  readonly note: string;
  readonly source: string | null;
  readonly status: RiskStatus;
  readonly closedByRun: string | null;
  readonly closedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProofObservation {
  readonly runId: string;
  readonly repoId: string;
  readonly command: string;
  readonly source: string | null;
  readonly ok: boolean;
  readonly durationMs: number | null;
  readonly createdAt: string;
}

/** Aggregate over the observations for one command. Derived, never stored. */
export interface ProofProfile {
  readonly command: string;
  readonly runs: number;
  readonly passes: number;
  readonly passRate: number;
  /** min(pass, fail) / runs, 0 when the command always agrees with itself. */
  readonly flakiness: number;
}

export interface OntologySnapshot {
  readonly repoId: string;
  readonly decisions: readonly Decision[];
  readonly risks: readonly LedgerRisk[];
  readonly observations: readonly ProofObservation[];
}

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

// ---------------------------------------------------------------------------
// Extraction from Understanding prose.
// ponytail: naive scans over the prose the model wrote. The Understanding
// "how" is asked to name the load-bearing files, so this is a real signal, but
// upgrade to the diff's actual file and symbol lists once the Action ships them.
// ---------------------------------------------------------------------------

const PATH_RE =
  /\b[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|sql|sh|css|scss|html|json|ya?ml|toml)\b/g;

export const extractPaths = (text: string): string[] =>
  uniq(text.match(PATH_RE) ?? []);

/** Backtick-quoted identifiers, the way the house style marks code in prose. */
const SYMBOL_RE = /`([A-Za-z_$][A-Za-z0-9_$.]*)`/g;

export const extractSymbols = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(SYMBOL_RE)) if (m[1]) out.push(m[1]);
  return uniq(out);
};

const REF_RE = /#(\d+)/g;

export const extractRefs = (text: string): number[] => {
  const out: number[] = [];
  for (const m of text.matchAll(REF_RE)) out.push(Number(m[1]));
  return uniq(out);
};

// ---------------------------------------------------------------------------
// Derive ontology rows from one uploaded run. repoId is the slug the run row
// already keys on (upload.repo), so a decision joins straight back to its run.
// ---------------------------------------------------------------------------

export const deriveDecision = (u: RunUpload, now: string): Decision => {
  const prose = `${u.understanding.what} ${u.understanding.how}`;
  const refText = `${u.pr?.title ?? ""} ${u.understanding.what} ${u.understanding.why}`;
  return {
    runId: u.run.id,
    repoId: u.repo,
    prNumber: u.pr?.number ?? null,
    prAuthor: u.pr?.author ?? null,
    prTitle: u.pr?.title ?? null,
    headSha: u.pr?.headSha ?? null,
    what: u.understanding.what,
    why: u.understanding.why,
    touchedPaths: extractPaths(prose),
    touchedSymbols: extractSymbols(prose),
    refs: extractRefs(refText).filter((n) => n !== u.pr?.number),
    proofVerdict: proofVerdict(u.prove),
    mergedAt: null,
    createdAt: now,
  };
};

export const deriveRisks = (u: RunUpload, now: string): LedgerRisk[] =>
  u.understanding.risks.map((r, ord) => ({
    runId: u.run.id,
    ord,
    repoId: u.repo,
    prNumber: u.pr?.number ?? null,
    area: r.area,
    note: r.note,
    source: r.source ?? null,
    status: "open",
    closedByRun: null,
    closedReason: null,
    createdAt: now,
    updatedAt: now,
  }));

export const deriveObservation = (u: RunUpload, now: string): ProofObservation | null =>
  u.prove
    ? {
        runId: u.run.id,
        repoId: u.repo,
        command: u.prove.command,
        source: u.prove.source ?? null,
        ok: u.prove.exitCode === 0,
        durationMs: u.prove.durationMs ?? null,
        createdAt: now,
      }
    : null;

export const proofProfiles = (obs: readonly ProofObservation[]): ProofProfile[] => {
  const byCommand = new Map<string, { runs: number; passes: number }>();
  for (const o of obs) {
    const acc = byCommand.get(o.command) ?? { runs: 0, passes: 0 };
    acc.runs += 1;
    if (o.ok) acc.passes += 1;
    byCommand.set(o.command, acc);
  }
  return [...byCommand.entries()]
    .map(([command, { runs, passes }]) => {
      const fails = runs - passes;
      return {
        command,
        runs,
        passes,
        passRate: runs === 0 ? 0 : passes / runs,
        flakiness: runs === 0 ? 0 : Math.min(passes, fails) / runs,
      };
    })
    .sort((a, b) => a.command.localeCompare(b.command));
};

// ---------------------------------------------------------------------------
// Continuity pack. A new PR that overlaps a recent MERGED PR by the same author
// gets a small, cited pack of the earlier decisions and still-open risks.
// ---------------------------------------------------------------------------

export interface ContinuityTarget {
  readonly prNumber: number | null;
  readonly author: string | null;
  readonly touchedPaths: readonly string[];
  readonly touchedSymbols?: readonly string[];
  readonly refs: readonly number[];
}

export interface ContinuityPack {
  readonly decisions: ReadonlyArray<{
    readonly prNumber: number | null;
    readonly runId: string;
    readonly what: string;
    readonly why: string;
    readonly proofVerdict: ProofVerdict;
  }>;
  readonly openRisks: ReadonlyArray<{
    readonly prNumber: number | null;
    readonly runId: string;
    readonly area: string;
    readonly note: string;
  }>;
  readonly citations: readonly string[];
}

const overlaps = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((x) => b.includes(x));

export const assembleContinuityPack = (
  snapshot: OntologySnapshot,
  target: ContinuityTarget,
  limit = 3,
): ContinuityPack => {
  const relevant = snapshot.decisions
    .filter((d) => d.mergedAt !== null)
    .filter((d) => target.author != null && d.prAuthor === target.author)
    .filter((d) => d.prNumber == null || d.prNumber !== target.prNumber)
    .filter(
      (d) =>
        (d.prNumber != null && target.refs.includes(d.prNumber)) ||
        overlaps(d.touchedPaths, target.touchedPaths) ||
        overlaps(d.touchedSymbols, target.touchedSymbols ?? []),
    )
    .sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId),
    )
    .slice(0, limit);

  const runIds = new Set(relevant.map((d) => d.runId));
  const openRisks = snapshot.risks.filter(
    (r) => r.status === "open" && runIds.has(r.runId),
  );

  const cite = (prNumber: number | null, runId: string) =>
    `${prNumber != null ? `#${prNumber}` : "PR"} (${runId})`;

  return {
    decisions: relevant.map((d) => ({
      prNumber: d.prNumber,
      runId: d.runId,
      what: d.what,
      why: d.why,
      proofVerdict: d.proofVerdict,
    })),
    openRisks: openRisks.map((r) => ({
      prNumber: r.prNumber,
      runId: r.runId,
      area: r.area,
      note: r.note,
    })),
    citations: uniq([
      ...relevant.map((d) => cite(d.prNumber, d.runId)),
      ...openRisks.map((r) => cite(r.prNumber, r.runId)),
    ]),
  };
};

/** The small cited block a lane prompt injects. Empty when there is no history. */
export const renderContinuityPack = (pack: ContinuityPack): string => {
  if (pack.decisions.length === 0 && pack.openRisks.length === 0) return "";
  const lines: string[] = ["Prior merged work this PR builds on:"];
  for (const d of pack.decisions) {
    const tag = d.prNumber != null ? `#${d.prNumber}` : "PR";
    lines.push(`- ${tag} (${d.runId}, proof ${d.proofVerdict}): ${d.what}`);
  }
  if (pack.openRisks.length > 0) {
    lines.push("Still-open risks from that work:");
    for (const r of pack.openRisks) {
      const tag = r.prNumber != null ? `#${r.prNumber}` : "PR";
      lines.push(`- ${tag} (${r.runId}) [${r.area}]: ${r.note}`);
    }
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Closing the loop. A later run confirms or refutes an open risk when it
// references the declaring PR or touches the risk's area, and it carries a real
// proof outcome: proof failed confirms the risk, proof passed refutes it.
// ponytail: reference or area-substring match; upgrade to real file overlap
// once decisions carry the diff's file list.
// ---------------------------------------------------------------------------

export interface ClosingRun {
  readonly runId: string;
  readonly refs: readonly number[];
  readonly touchedPaths: readonly string[];
  readonly proofVerdict: ProofVerdict;
}

export const resolveRisks = (
  open: readonly LedgerRisk[],
  run: ClosingRun,
  now: string,
): LedgerRisk[] => {
  if (run.proofVerdict === "neutral") return [];
  const status: RiskStatus = run.proofVerdict === "failure" ? "confirmed" : "refuted";
  const reason =
    run.proofVerdict === "failure"
      ? `proof failed in ${run.runId}`
      : `proof passed in ${run.runId}`;
  return open
    .filter((r) => r.status === "open" && r.runId !== run.runId)
    .filter(
      (r) =>
        (r.prNumber != null && run.refs.includes(r.prNumber)) ||
        run.touchedPaths.some((p) => p.includes(r.area)),
    )
    .map((r) => ({
      ...r,
      status,
      closedByRun: run.runId,
      closedReason: reason,
      updatedAt: now,
    }));
};

// ---------------------------------------------------------------------------
// SQLite export and import. "Your memory is yours": one file, lossless both
// ways. Arrays are stored as JSON text and booleans as 0/1, and read back to
// the exact same shapes, so export then import equals the source snapshot.
// ---------------------------------------------------------------------------

const SQLITE_SCHEMA = `
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE decision_log (
  run_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pr_number INTEGER,
  pr_author TEXT, pr_title TEXT, head_sha TEXT, what TEXT NOT NULL, why TEXT NOT NULL,
  touched_paths TEXT NOT NULL, touched_symbols TEXT NOT NULL, refs TEXT NOT NULL,
  proof_verdict TEXT NOT NULL, merged_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE risk_ledger (
  run_id TEXT NOT NULL, ord INTEGER NOT NULL, repo_id TEXT NOT NULL, pr_number INTEGER,
  area TEXT NOT NULL, note TEXT NOT NULL, source TEXT, status TEXT NOT NULL,
  closed_by_run TEXT, closed_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, ord)
);
CREATE TABLE proof_observation (
  run_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, command TEXT NOT NULL, source TEXT,
  ok INTEGER NOT NULL, duration_ms INTEGER, created_at TEXT NOT NULL
);
`;

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

export const exportOntologySqlite = (snapshot: OntologySnapshot): Buffer => {
  const dir = mkdtempSync(join(tmpdir(), "verit-ontology-"));
  const file = join(dir, "ontology.db");
  const db = new DatabaseSync(file);
  try {
    db.exec(SQLITE_SCHEMA);
    db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)").run("repo_id", snapshot.repoId);
    db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)").run("version", "0");

    const d = db.prepare(
      `INSERT INTO decision_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const x of snapshot.decisions) {
      d.run(
        x.runId, x.repoId, x.prNumber, x.prAuthor, x.prTitle, x.headSha, x.what, x.why,
        JSON.stringify(x.touchedPaths), JSON.stringify(x.touchedSymbols),
        JSON.stringify(x.refs), x.proofVerdict, x.mergedAt, x.createdAt,
      );
    }

    const r = db.prepare(`INSERT INTO risk_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const x of snapshot.risks) {
      r.run(
        x.runId, x.ord, x.repoId, x.prNumber, x.area, x.note, x.source, x.status,
        x.closedByRun, x.closedReason, x.createdAt, x.updatedAt,
      );
    }

    const p = db.prepare(`INSERT INTO proof_observation VALUES (?,?,?,?,?,?,?)`);
    for (const x of snapshot.observations) {
      p.run(
        x.runId, x.repoId, x.command, x.source, x.ok ? 1 : 0, x.durationMs, x.createdAt,
      );
    }

    db.close();
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const importOntologySqlite = (bytes: Buffer): OntologySnapshot => {
  const dir = mkdtempSync(join(tmpdir(), "verit-ontology-"));
  const file = join(dir, "ontology.db");
  writeFileSync(file, bytes);
  const db = new DatabaseSync(file);
  try {
    const repoRow = db.prepare("SELECT v FROM meta WHERE k = 'repo_id'").get() as
      | { v: string }
      | undefined;

    const decisions: Decision[] = (
      db.prepare("SELECT * FROM decision_log").all() as Record<string, unknown>[]
    ).map((x) => ({
      runId: String(x.run_id),
      repoId: String(x.repo_id),
      prNumber: num(x.pr_number),
      prAuthor: str(x.pr_author),
      prTitle: str(x.pr_title),
      headSha: str(x.head_sha),
      what: String(x.what),
      why: String(x.why),
      touchedPaths: JSON.parse(String(x.touched_paths)) as string[],
      touchedSymbols: JSON.parse(String(x.touched_symbols)) as string[],
      refs: JSON.parse(String(x.refs)) as number[],
      proofVerdict: String(x.proof_verdict) as ProofVerdict,
      mergedAt: str(x.merged_at),
      createdAt: String(x.created_at),
    }));

    const risks: LedgerRisk[] = (
      db.prepare("SELECT * FROM risk_ledger").all() as Record<string, unknown>[]
    ).map((x) => ({
      runId: String(x.run_id),
      ord: Number(x.ord),
      repoId: String(x.repo_id),
      prNumber: num(x.pr_number),
      area: String(x.area),
      note: String(x.note),
      source: str(x.source),
      status: String(x.status) as RiskStatus,
      closedByRun: str(x.closed_by_run),
      closedReason: str(x.closed_reason),
      createdAt: String(x.created_at),
      updatedAt: String(x.updated_at),
    }));

    const observations: ProofObservation[] = (
      db.prepare("SELECT * FROM proof_observation").all() as Record<string, unknown>[]
    ).map((x) => ({
      runId: String(x.run_id),
      repoId: String(x.repo_id),
      command: String(x.command),
      source: str(x.source),
      ok: Number(x.ok) === 1,
      durationMs: num(x.duration_ms),
      createdAt: String(x.created_at),
    }));

    return { repoId: repoRow?.v ?? "", decisions, risks, observations };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
};
