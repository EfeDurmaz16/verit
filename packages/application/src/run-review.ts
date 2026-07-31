import { Effect } from "effect";
import type { ReviewContext, ReviewPresets, Understanding } from "@cyclops/domain";
import type {
  ClassifierPort,
  DocumentStore,
  GraphStore,
  HarnessPort,
  ProofRenderPort,
  StoreError,
} from "@cyclops/ports";
import { compileReviewPack } from "./compiler.js";
import { contentHash } from "./edges.js";
import { understandingToProofSpec } from "./proof-spec.js";

export const runReviewUnderstand = (deps: {
  docs: DocumentStore;
  graph: GraphStore;
  harness: HarnessPort;
  classifier: ClassifierPort;
  render: ProofRenderPort;
}) =>
(input: {
  repoId: string;
  prId?: string;
  title: string;
  body: string;
  paths: readonly string[];
  diff: string;
  context: ReviewContext;
  presets: ReviewPresets;
  nowIso: string;
}): Effect.Effect<{ runId: string; understanding: Understanding; spec: unknown; skillPackHash: string }, StoreError> =>
  Effect.gen(function* () {
    const classified = yield* deps.classifier.classify({
      title: input.title,
      body: input.body,
      paths: input.paths,
    });
    const domain = input.presets.domain !== "GENERAL" ? input.presets.domain : classified.domain;
    const focus = input.presets.focus ?? classified.focus;
    const presets = { ...input.presets, domain, focus };
    const compiled = compileReviewPack(presets);
    const context = { ...input.context, domain, focus };
    const understanding = yield* deps.harness.runUnderstand({
      title: input.title,
      body: input.body,
      paths: input.paths,
      diff: input.diff,
      context,
      role: "review",
    });
    const runId = `run:${compiled.skillPackHash.slice(0, 12)}:${Date.now()}`;
    yield* deps.docs.upsertReviewRun({
      id: runId,
      repoId: input.repoId,
      prId: input.prId,
      skillPackHash: compiled.skillPackHash,
      domain,
      focus,
      createdAt: input.nowIso,
    });
    yield* deps.docs.saveUnderstandingJson(runId, understanding);
    const archNodes = input.paths.slice(0, 24).map((p) => ({
      id: p,
      label: p.split("/").pop() ?? p,
    }));
    const archEdges =
      archNodes.length > 1
        ? archNodes.slice(1).map((n, i) => ({
            from: archNodes[0]!.id,
            to: n.id,
            kind: i === 0 ? "touches" : "co-changed",
          }))
        : [];
    const spec = deps.render.toSpec({
      understanding,
      context,
      risksReviewer: understanding.risks.filter((r) => r.source === "reviewer"),
      archNodes,
      archEdges,
    });
    const body = JSON.stringify(spec);
    yield* deps.docs.upsertProofArtifact({
      id: `proof:${runId}:spec`,
      runId,
      kind: "json_render_spec",
      contentType: "application/json",
      body,
      contentHash: contentHash(body),
    });
    if (input.prId) {
      yield* deps.graph.linkRunToPr(runId, input.prId);
    }
    return { runId, understanding, spec, skillPackHash: compiled.skillPackHash };
  });
