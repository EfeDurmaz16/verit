import { Schema as S } from "effect";

/*
 * What verit is allowed to remember across runs.
 *
 * The flywheel needs three things: which environments a repository actually
 * builds in, which probes hold steady and which flake, and what maintainers did
 * with the evidence. None of those need the repository's code, its logs or its
 * artifacts, so none of those are here.
 *
 * The rule is stated as a shape rather than a policy. Every record below is a
 * closed struct of identifiers, digests, enums and counts. There is no free
 * text field a log line could be dropped into, and `normalizeForCorpus` is the
 * one door in: it builds records from an allowlist, so a caller cannot widen
 * what is stored by passing more.
 *
 * Cross-customer reuse is what makes this a corpus rather than a cache, and it
 * is exactly why raw content is not permitted. A digest tells us two runs saw
 * the same lockfile without telling us what was in it.
 */

/** A repository, as a stable opaque id. Never the slug, which names people. */
export const CorpusRepoId = S.String.pipe(S.minLength(1));
export type CorpusRepoId = S.Schema.Type<typeof CorpusRepoId>;

/**
 * What it took to get a repository to the point of running anything.
 *
 * This is the execution memory: the next run reads it to guess a working
 * install command and a warm environment instead of rediscovering them.
 */
export const ExecutionMemoryRecord = S.Struct({
  repoId: CorpusRepoId,
  /** Digest of the toolchain files present, never their contents. */
  toolchainDigest: S.String,
  /** Digest of the manifests and lockfiles present, never their contents. */
  dependencyDigest: S.String,
  /** The install command shape, e.g. "pnpm install --frozen-lockfile". */
  installCommand: S.String,
  installOutcome: S.Literal("ok", "failed", "skipped"),
  installMillis: S.Number.pipe(S.greaterThanOrEqualTo(0)),
  /** Digest of the ExecutionPolicy the run used. */
  policyDigest: S.String,
  observedAt: S.String.pipe(S.minLength(1)),
});
export type ExecutionMemoryRecord = S.Schema.Type<typeof ExecutionMemoryRecord>;

/**
 * How a probe behaved. Counts and states, never output.
 *
 * Stability is the thing worth remembering: a probe that disagreed with itself
 * before is one whose next regression should be read carefully.
 */
export const OutcomeRecord = S.Struct({
  repoId: CorpusRepoId,
  /** sha256 of the probe source. The probe itself is not stored. */
  probeHash: S.String.pipe(S.minLength(1)),
  probeOrigin: S.Literal("repo-native", "generated", "maintainer-supplied"),
  baseState: S.String.pipe(S.minLength(1)),
  headState: S.String.pipe(S.minLength(1)),
  classification: S.String.pipe(S.minLength(1)),
  grade: S.NullOr(S.String),
  runsPerSide: S.Number.pipe(S.greaterThanOrEqualTo(1)),
  /** True when every repeat on both sides agreed. */
  stable: S.Boolean,
  observedAt: S.String.pipe(S.minLength(1)),
});
export type OutcomeRecord = S.Schema.Type<typeof OutcomeRecord>;

/**
 * What a human did with a result. The only feedback that calibrates anything,
 * and the reason a disposition is kept beside the evidence rather than folded
 * into its grade.
 */
export const DecisionRecord = S.Struct({
  repoId: CorpusRepoId,
  probeHash: S.String.pipe(S.minLength(1)),
  classification: S.String.pipe(S.minLength(1)),
  grade: S.NullOr(S.String),
  disposition: S.Literal("accepted", "rejected", "needs-work", "unreviewed"),
  readiness: S.String.pipe(S.minLength(1)),
  observedAt: S.String.pipe(S.minLength(1)),
});
export type DecisionRecord = S.Schema.Type<typeof DecisionRecord>;

export const decodeExecutionMemory = S.decodeUnknownEither(ExecutionMemoryRecord);
export const decodeOutcomeRecord = S.decodeUnknownEither(OutcomeRecord);
export const decodeDecisionRecord = S.decodeUnknownEither(DecisionRecord);

/* -------------------------------------------------------------------------- */
/* The one door in.                                                            */
/* -------------------------------------------------------------------------- */

/** Anything that looks like content rather than a fact about a run. */
const FORBIDDEN_KEYS = [
  "source",
  "log",
  "logs",
  "logtail",
  "output",
  "stdout",
  "stderr",
  "artifact",
  "artifacts",
  "artifactrefs",
  "diff",
  "patch",
  "body",
  "statement",
  "note",
  "content",
  "token",
  "secret",
  "key",
  "email",
  "author",
  "path",
  "paths",
  "file",
  "files",
];

/**
 * True when a key names content rather than a fact about a run.
 *
 * Used by the tests to hold the shapes above to the privacy contract, so a
 * field added later that would carry code, logs or a person into the corpus
 * fails the suite rather than shipping.
 */
export const isForbiddenCorpusKey = (key: string): boolean => {
  const k = key.toLowerCase();
  return FORBIDDEN_KEYS.some((f) => k === f || k.endsWith(f));
};

const nowIso = (at?: string): string => at ?? new Date().toISOString();

/**
 * Build an execution memory record from an allowlist.
 *
 * Fields are copied one at a time on purpose. A caller that passes a whole run
 * object cannot widen what is stored, because nothing here spreads its input.
 */
export const normalizeExecutionMemory = (input: {
  repoId: string;
  toolchainDigest?: string;
  dependencyDigest?: string;
  installCommand?: string;
  installOutcome?: "ok" | "failed" | "skipped";
  installMillis?: number;
  policyDigest?: string;
  observedAt?: string;
}): ExecutionMemoryRecord => ({
  repoId: input.repoId,
  toolchainDigest: input.toolchainDigest ?? "",
  dependencyDigest: input.dependencyDigest ?? "",
  installCommand: input.installCommand ?? "",
  installOutcome: input.installOutcome ?? "skipped",
  installMillis: Math.max(0, Math.round(input.installMillis ?? 0)),
  policyDigest: input.policyDigest ?? "",
  observedAt: nowIso(input.observedAt),
});

export const normalizeOutcome = (input: {
  repoId: string;
  probeHash: string;
  probeOrigin: "repo-native" | "generated" | "maintainer-supplied";
  baseState: string;
  headState: string;
  classification: string;
  grade?: string | null;
  runsPerSide?: number;
  stable?: boolean;
  observedAt?: string;
}): OutcomeRecord => ({
  repoId: input.repoId,
  probeHash: input.probeHash,
  probeOrigin: input.probeOrigin,
  baseState: input.baseState,
  headState: input.headState,
  classification: input.classification,
  grade: input.grade ?? null,
  runsPerSide: Math.max(1, Math.round(input.runsPerSide ?? 1)),
  stable: input.stable ?? false,
  observedAt: nowIso(input.observedAt),
});

export const normalizeDecision = (input: {
  repoId: string;
  probeHash: string;
  classification: string;
  grade?: string | null;
  disposition: "accepted" | "rejected" | "needs-work" | "unreviewed";
  readiness: string;
  observedAt?: string;
}): DecisionRecord => ({
  repoId: input.repoId,
  probeHash: input.probeHash,
  classification: input.classification,
  grade: input.grade ?? null,
  disposition: input.disposition,
  readiness: input.readiness,
  observedAt: nowIso(input.observedAt),
});

/**
 * Whether this repository's runs may be remembered at all.
 *
 * Public repositories default to on, with the collection stated at install and
 * a repository level opt out. Private repositories are off until someone says
 * otherwise. Anything unknown is off: an absent answer is not consent.
 */
export const corpusConsent = (input: {
  visibility: "public" | "private" | "unknown";
  optOut?: boolean;
  optIn?: boolean;
}): boolean => {
  if (input.optOut === true) return false;
  if (input.visibility === "public") return true;
  if (input.visibility === "private") return input.optIn === true;
  return false;
};
