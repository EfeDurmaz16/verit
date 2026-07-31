import type {
  FileNode,
  IndexChunk,
  PREdge,
  ProofArtifact,
  PullRequest,
  Repo,
  ReviewContext,
  ReviewDomain,
  ReviewPresets,
  ReviewRun,
  SymbolNode,
  Understanding,
  WikiHit,
  WikiPage,
} from "@cyclops/domain";
import type { Effect } from "effect";

export class StoreError extends Error {
  readonly _tag = "StoreError" as const;
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface DocumentStore {
  readonly upsertReviewRun: (run: ReviewRun) => Effect.Effect<void, StoreError>;
  readonly getReviewRun: (id: string) => Effect.Effect<ReviewRun | null, StoreError>;
  readonly upsertProofArtifact: (a: ProofArtifact) => Effect.Effect<void, StoreError>;
  readonly listProofArtifacts: (runId: string) => Effect.Effect<readonly ProofArtifact[], StoreError>;
  readonly upsertChunk: (c: IndexChunk) => Effect.Effect<void, StoreError>;
  readonly searchChunks: (repoId: string, q: string, limit: number) => Effect.Effect<readonly IndexChunk[], StoreError>;
  readonly saveUnderstandingJson: (runId: string, u: Understanding) => Effect.Effect<void, StoreError>;
  readonly getUnderstandingJson: (runId: string) => Effect.Effect<Understanding | null, StoreError>;
}

export interface GraphStore {
  readonly upsertRepo: (r: Repo) => Effect.Effect<void, StoreError>;
  readonly upsertFile: (f: FileNode) => Effect.Effect<void, StoreError>;
  readonly upsertSymbol: (s: SymbolNode) => Effect.Effect<void, StoreError>;
  readonly upsertWikiPage: (w: WikiPage) => Effect.Effect<void, StoreError>;
  readonly upsertPullRequest: (p: PullRequest) => Effect.Effect<void, StoreError>;
  readonly upsertPREdge: (e: PREdge) => Effect.Effect<void, StoreError>;
  readonly listWikiPages: (repoId: string) => Effect.Effect<readonly WikiPage[], StoreError>;
  readonly listPREdges: (prId: string) => Effect.Effect<readonly PREdge[], StoreError>;
  readonly getPullRequest: (id: string) => Effect.Effect<PullRequest | null, StoreError>;
  readonly listPullRequests: (repoId: string) => Effect.Effect<readonly PullRequest[], StoreError>;
  readonly linkRunToPr: (runId: string, prId: string) => Effect.Effect<void, StoreError>;
}

export interface ParserPort {
  readonly extractSymbols: (
    path: string,
    source: string,
  ) => Effect.Effect<readonly Omit<SymbolNode, "id" | "fileId">[], StoreError>;
}

export interface VcsPort {
  readonly fetchPullRequest: (
    owner: string,
    repo: string,
    number: number,
  ) => Effect.Effect<
    {
      pr: PullRequest;
      closingNumbers: readonly number[];
      changedPaths: readonly string[];
      /** Unified patch when available (may be truncated by host). */
      patch: string;
    },
    StoreError
  >;
}

export interface ClassifierPort {
  readonly classify: (input: {
    title: string;
    body: string;
    paths: readonly string[];
  }) => Effect.Effect<{ domain: ReviewDomain; focus?: ReviewDomain; confidence: number }, StoreError>;
}

export interface HarnessPort {
  readonly runUnderstand: (input: {
    title: string;
    body: string;
    paths: readonly string[];
    diff: string;
    context: ReviewContext;
    role: "implement" | "review";
  }) => Effect.Effect<Understanding, StoreError>;
}

export interface CompilerPort {
  readonly compileReviewPack: (presets: ReviewPresets) => {
    skillsToml: string;
    skillPackHash: string;
    append: string;
  };
}

export interface BlobPort {
  readonly writeLocal: (name: string, body: string) => Effect.Effect<string, StoreError>;
}

export interface ProofRenderPort {
  readonly toSpec: (input: {
    understanding: Understanding;
    context: ReviewContext;
    risksReviewer: Understanding["risks"];
    archNodes?: Array<{ id: string; label: string }>;
    archEdges?: Array<{ from: string; to: string; kind?: string }>;
    suggestedPatch?: string;
  }) => unknown;
}
