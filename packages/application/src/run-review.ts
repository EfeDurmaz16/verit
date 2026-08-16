import { Effect } from "effect";
import { DIFF_BUDGET_CHARS, diffCoveragePercent } from "@verit/domain";
import { netDiffChars } from "@verit/netdiff";
import type { ReviewContext, ReviewPresets, ReviewRun, Understanding } from "@verit/domain";
import type {
  ClassifierPort,
  DocumentStore,
  GraphStore,
  HarnessPort,
  ProofRenderPort,
  StoreError,
} from "@verit/ports";
import { compileReviewPack } from "./compiler";
import { contentHash } from "./edges";
import { understandingToProofSpec } from "./proof-spec";

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
}): Effect.Effect<
  {
    runId: string;
    /** The row this verb wrote. The dashboard upload posts it verbatim. */
    run: ReviewRun;
    /** Null when the lane did not complete. The run then has no analysis. */
    understanding: Understanding | null;
    spec: unknown;
    skillPackHash: string;
    /** Net size of the diff, moves factored out: the coverage denominator. */
    netDiffChars: number;
  },
  StoreError
> =>
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
    const raw = yield* deps.harness.runUnderstand({
      title: input.title,
      body: input.body,
      paths: input.paths,
      diff: input.diff,
      context,
      role: "review",
    });
    // The lane reviews the NET diff: @verit/netdiff factors moved code out
    // before the budget applies, so the denominator here is net chars, not
    // gross. When even the net content does not fit DIFF_BUDGET_CHARS, the
    // analysis is partial and the Understanding must say so out loud.
    const netChars = netDiffChars(input.diff);
    const coverage = diffCoveragePercent(netChars);
    const understanding: Understanding | null =
      raw === null || coverage === 100
        ? raw
        : {
            ...raw,
            risks: [
              ...raw.risks,
              {
                area: "coverage",
                note: `Reviewed ${coverage}% of the net diff, code moves factored out (${DIFF_BUDGET_CHARS} of ${netChars} net chars). Analysis is partial.`,
                source: "reviewer",
              },
            ],
          };
    const runId = `run:${compiled.skillPackHash.slice(0, 12)}:${Date.now()}`;
    const run: ReviewRun = {
      id: runId,
      repoId: input.repoId,
      prId: input.prId,
      skillPackHash: compiled.skillPackHash,
      domain,
      focus,
      createdAt: input.nowIso,
    };
    yield* deps.docs.upsertReviewRun(run);
    if (understanding === null) {
      // The lane failed. Record the run, store nothing invented, render no
      // spec. The caller reports "analysis did not complete" and the Check
      // goes neutral whatever the prove result says.
      if (input.prId) {
        yield* deps.graph.linkRunToPr(runId, input.prId);
      }
      return {
        runId,
        run,
        understanding: null,
        spec: null,
        skillPackHash: compiled.skillPackHash,
        netDiffChars: netChars,
      };
    }
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
    return {
      runId,
      run,
      understanding,
      spec,
      skillPackHash: compiled.skillPackHash,
      netDiffChars: netChars,
    };
  });
