import { buildReviewContext, runReviewUnderstand } from "@verit/application";
import { makeHeuristicClassifier, makeMemoryGraphStore, makeProofRender } from "@verit/adapter-memory";
import type { ReviewPresets, Understanding } from "@verit/domain";
import type { HarnessPort } from "@verit/ports";
import { Cause, Effect, Exit, Option } from "effect";
import { fetchDiff } from "./prefetch";
import type { PRMeta } from "./schema";
import { docs } from "./stores";

const PRESETS: ReviewPresets = {
  reviewer_identity: "normal",
  proof_frequency: "behavior_default",
  codebase_automation: "off",
  inline_comments: "high_conf_only",
  domain: "GENERAL",
};

/**
 * A HarnessPort that hands back an Understanding the CLI lane already produced
 * and validated on disk. The legacy codex/claude/cursor path runs inside the
 * streaming session, so by the time the pipeline asks, the answer is in hand.
 */
const staticHarness = (understanding: Understanding): HarnessPort => ({
  runUnderstand: () => Effect.succeed(understanding),
});

/**
 * Run one PR through the verit review pipeline with the given harness and
 * persist the result: a ReviewRun row, the Understanding JSON, and the proof
 * spec. Returns the run id plus the Understanding the harness produced (null
 * when the lane did not complete, which the pipeline records as a neutral run).
 *
 * The harness is the seam: the harness-independent HTTP lane (@verit/lane) for
 * the default provider path, or staticHarness for a finished CLI lane run.
 */
export async function reviewViaLane(
  pr: PRMeta,
  harness: HarnessPort,
  signal?: AbortSignal,
): Promise<{ runId: string; understanding: Understanding | null }> {
  const diff = await fetchDiff(pr.repo, pr.number).catch(() => "");
  const paths = pr.files.map((f) => f.path);
  const exit = await Effect.runPromiseExit(
    runReviewUnderstand({
      docs: docs(),
      // no ontology graph behind the workspace yet, the Action owns that path
      graph: makeMemoryGraphStore(),
      harness,
      classifier: makeHeuristicClassifier(),
      render: makeProofRender(),
    })({
      repoId: `repo:${pr.repo}`,
      prId: `pr:${pr.repo}#${pr.number}`,
      title: pr.title,
      body: pr.body,
      paths,
      diff,
      context: buildReviewContext({
        pages: [],
        query: pr.title,
        edges: [],
        prs: [],
        domain: "GENERAL",
      }),
      presets: PRESETS,
      nowIso: new Date().toISOString(),
    }),
    signal ? { signal } : undefined,
  );
  if (Exit.isSuccess(exit)) {
    return { runId: exit.value.runId, understanding: exit.value.understanding };
  }
  // Surface the underlying failure (a StoreError from lane misconfig) with its
  // real message intact, not a pretty-printed fiber trace.
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  throw failure ?? new Error(Cause.pretty(exit.cause));
}

/**
 * Persist a finished CLI-lane run: the Understanding is already validated on
 * disk, so the pipeline runs with staticHarness and never calls a model.
 */
export async function persistReviewRun(
  pr: PRMeta,
  understanding: Understanding,
): Promise<string> {
  const { runId } = await reviewViaLane(pr, staticHarness(understanding));
  return runId;
}

/** The Understanding a finished run stored, for rehydrating without re-running. */
export async function readStoredUnderstanding(
  reviewRunId: string,
): Promise<Understanding | null> {
  return Effect.runPromise(docs().getUnderstandingJson(reviewRunId)).catch(() => null);
}
