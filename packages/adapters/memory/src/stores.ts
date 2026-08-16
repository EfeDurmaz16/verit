import { Effect } from "effect";
import type {
  FileNode,
  IndexChunk,
  PREdge,
  ProofArtifact,
  PullRequest,
  Repo,
  ReviewRun,
  SymbolNode,
  Understanding,
  WikiPage,
} from "@verit/domain";
import type { DocumentStore, GraphStore } from "@verit/ports";

export const makeMemoryDocumentStore = (): DocumentStore => {
  const runs = new Map<string, ReviewRun>();
  const proofs = new Map<string, ProofArtifact>();
  const chunks = new Map<string, IndexChunk>();
  const understandings = new Map<string, Understanding>();

  return {
    upsertReviewRun: (run) => Effect.sync(() => void runs.set(run.id, run)),
    getReviewRun: (id) => Effect.succeed(runs.get(id) ?? null),
    upsertProofArtifact: (a) => Effect.sync(() => void proofs.set(a.id, a)),
    listProofArtifacts: (runId) =>
      Effect.succeed([...proofs.values()].filter((p) => p.runId === runId)),
    upsertChunk: (c) => Effect.sync(() => void chunks.set(c.id, c)),
    searchChunks: (repoId, q, limit) =>
      Effect.sync(() => {
        const needle = q.toLowerCase();
        return [...chunks.values()]
          .filter((c) => c.repoId === repoId && c.text.toLowerCase().includes(needle))
          .slice(0, limit);
      }),
    saveUnderstandingJson: (runId, u) => Effect.sync(() => void understandings.set(runId, u)),
    getUnderstandingJson: (runId) => Effect.succeed(understandings.get(runId) ?? null),
  };
};

export const makeMemoryGraphStore = (): GraphStore => {
  const repos = new Map<string, Repo>();
  const files = new Map<string, FileNode>();
  const symbols = new Map<string, SymbolNode>();
  const wikis = new Map<string, WikiPage>();
  const prs = new Map<string, PullRequest>();
  const edges = new Map<string, PREdge>();
  const runLinks = new Map<string, string>();

  return {
    upsertRepo: (r) => Effect.sync(() => void repos.set(r.id, r)),
    upsertFile: (f) => Effect.sync(() => void files.set(f.id, f)),
    upsertSymbol: (s) => Effect.sync(() => void symbols.set(s.id, s)),
    upsertWikiPage: (w) => Effect.sync(() => void wikis.set(w.id, w)),
    upsertPullRequest: (p) => Effect.sync(() => void prs.set(p.id, p)),
    upsertPREdge: (e) => Effect.sync(() => void edges.set(e.id, e)),
    listWikiPages: (repoId) =>
      Effect.succeed([...wikis.values()].filter((w) => w.repoId === repoId)),
    listPREdges: (prId) =>
      Effect.succeed(
        [...edges.values()].filter((e) => e.fromPrId === prId || e.toPrId === prId),
      ),
    getPullRequest: (id) => Effect.succeed(prs.get(id) ?? null),
    listPullRequests: (repoId) =>
      Effect.succeed([...prs.values()].filter((p) => p.repoId === repoId)),
    linkRunToPr: (runId, prId) => Effect.sync(() => void runLinks.set(runId, prId)),
  };
};
