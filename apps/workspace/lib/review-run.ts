import { buildReviewContext, runReviewUnderstand } from "@cyclops/application";
import { makeHeuristicClassifier, makeMemoryGraphStore, makeProofRender } from "@cyclops/adapter-memory";
import type { ReviewPresets, Understanding } from "@cyclops/domain";
import type { HarnessPort } from "@cyclops/ports";
import { Effect } from "effect";
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
 * The lane harness as a HarnessPort. The codex lane runs inside the streaming
 * session (that is the whole point of the workspace), so by the time the
 * pipeline asks for an Understanding the lane has already produced and
 * validated one. Swapping Codex for Pi means swapping this for `makePiHarness`.
 */
const laneHarness = (understanding: Understanding): HarnessPort => ({
  runUnderstand: () => Effect.succeed(understanding),
});

/**
 * Persist a finished workspace run through the cyclops pipeline: a ReviewRun
 * row, the Understanding JSON, and the rendered proof spec. Returns the
 * ReviewRun id so the session can point at it.
 */
export async function persistReviewRun(
  pr: PRMeta,
  understanding: Understanding,
): Promise<string> {
  const diff = await fetchDiff(pr.repo, pr.number).catch(() => "");
  const paths = pr.files.map((f) => f.path);
  const result = await Effect.runPromise(
    runReviewUnderstand({
      docs: docs(),
      // no ontology graph behind the workspace yet — the Action owns that path
      graph: makeMemoryGraphStore(),
      harness: laneHarness(understanding),
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
  );
  return result.runId;
}

/** The Understanding a finished run stored, for rehydrating without re-running. */
export async function readStoredUnderstanding(
  reviewRunId: string,
): Promise<Understanding | null> {
  return Effect.runPromise(docs().getUnderstandingJson(reviewRunId)).catch(() => null);
}
