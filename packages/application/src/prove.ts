import { Effect } from "effect";
import type { ProofRef, Understanding } from "@verit/domain";
import type { DocumentStore, GitState, ProveOutcome, ProvePort, StoreError } from "@verit/ports";
import { contentHash } from "./edges";

/** Marks the refs this verb owns, so a re-run replaces its own evidence only. */
export const PROVE_PREFIX = "prove: ";

export const isProveRef = (r: ProofRef): boolean => r.label.startsWith(PROVE_PREFIX);

const verdict = (o: ProveOutcome): string =>
  o.refused != null
    ? "refused"
    : o.timedOut
      ? "timed out"
      : o.exitCode === 0
        ? "passed"
        : "failed";

/**
 * The evidence a run actually produced. A non-zero exit is carried as
 * `status: "fail"` and said plainly in the label. A failed proof is a result,
 * not something to soften. A refused run never counts as a pass.
 */
export const proveRef = (o: ProveOutcome): ProofRef => ({
  kind: "test",
  label: `${PROVE_PREFIX}${o.command}, ${verdict(o)}`,
  value:
    o.refused != null
      ? `refused: ${o.refused}`
      : `exit ${o.exitCode} · ${(o.durationMs / 1000).toFixed(1)}s · ${o.source} · ${o.cwd}`,
  status: o.exitCode === 0 && o.refused == null ? "pass" : "fail",
  log: o.logTail,
});

export const withProveRef = (u: Understanding, o: ProveOutcome): Understanding => ({
  ...u,
  proof_refs: [...u.proof_refs.filter((r) => !isProveRef(r)), proveRef(o)],
});

export const proveLogBody = (o: ProveOutcome): string =>
  o.refused != null
    ? [
        `$ ${o.command}`,
        `cwd:   ${o.cwd} (${o.repo})`,
        `head:  ${o.headSha ?? "unknown"}`,
        `began: ${o.startedAt}`,
        `prove refused: ${o.refused}`,
      ].join("\n")
    : [
        `$ ${o.command}`,
        `cwd:   ${o.cwd} (${o.repo})`,
        `head:  ${o.headSha ?? "unknown"}, tree ${o.porcelainClean ? "clean" : "dirty"}`,
        `from:  ${o.source}`,
        `began: ${o.startedAt}`,
        `exit:  ${o.exitCode} after ${(o.durationMs / 1000).toFixed(1)}s${o.timedOut ? " (timed out)" : ""}`,
        "",
        o.log || o.logTail,
      ].join("\n");

/**
 * The real `prove` verb: run the target repo's own verification command, hang
 * the outcome on the Understanding, and keep the log as a proof artifact of
 * the ReviewRun. The port refuses to run anywhere but the named repo.
 */
export const runProve = (deps: { prove: ProvePort; docs: DocumentStore }) =>
(input: {
  runId: string;
  cwd: string;
  expectRepo: string;
  /** Null when the lane produced no analysis. Prove still runs and logs. */
  understanding: Understanding | null;
  timeoutMs?: number;
  /** Git snapshot from before the lane ran. Prove refuses if the tree moved. */
  baseline?: GitState | null;
}): Effect.Effect<{ understanding: Understanding | null; outcome: ProveOutcome }, StoreError> =>
  Effect.gen(function* () {
    const outcome = yield* deps.prove.run({
      cwd: input.cwd,
      expectRepo: input.expectRepo,
      timeoutMs: input.timeoutMs,
      baseline: input.baseline,
    });
    const understanding =
      input.understanding === null ? null : withProveRef(input.understanding, outcome);
    if (understanding !== null) {
      yield* deps.docs.saveUnderstandingJson(input.runId, understanding);
    }
    const body = proveLogBody(outcome);
    yield* deps.docs.upsertProofArtifact({
      id: `proof:${input.runId}:prove`,
      runId: input.runId,
      kind: "sandbox_log",
      contentType: "text/plain",
      body,
      contentHash: contentHash(body),
    });
    return { understanding, outcome };
  });
