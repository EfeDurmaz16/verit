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
  WorkspaceRun,
  WorkspaceSession,
} from "@verit/domain";
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

/**
 * Live-workspace session persistence. SQLite today, Postgres later: swapping
 * the implementation is the whole migration, nothing above this depends on it.
 */
export interface SessionStore {
  readonly upsertSession: (s: WorkspaceSession) => Effect.Effect<void, StoreError>;
  readonly getSession: (id: string) => Effect.Effect<WorkspaceSession | null, StoreError>;
  readonly upsertRun: (r: WorkspaceRun) => Effect.Effect<void, StoreError>;
  readonly latestRun: (sessionId: string) => Effect.Effect<WorkspaceRun | null, StoreError>;
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

/**
 * Produces the Understanding of one change, or null when the lane did not
 * complete (no harness configured, spawn failure, timeout, invalid output).
 * Null is an honest answer: the pipeline reports "analysis did not complete"
 * and the Check goes neutral. No adapter may invent an Understanding instead.
 */
export interface HarnessPort {
  readonly runUnderstand: (input: {
    title: string;
    body: string;
    paths: readonly string[];
    diff: string;
    context: ReviewContext;
    role: "implement" | "review";
  }) => Effect.Effect<Understanding | null, StoreError>;
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

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/**
 * Keyed object storage, shaped like the S3 subset the dashboard uses. The
 * filesystem adapter backs local development; R2 backs the hosted deployment.
 * Keys are `runs/<runId>/<name>`: flat strings, never filesystem paths, and an
 * adapter must reject any key it cannot map safely.
 */
export interface ObjectStorePort {
  readonly put: (
    key: string,
    body: string | Uint8Array,
    contentType: string,
  ) => Effect.Effect<void, StoreError>;
  readonly get: (key: string) => Effect.Effect<StoredObject | null, StoreError>;
}

/**
 * The whole alphabet an object key may use: dot-segments cannot appear, and
 * nothing here needs URL escaping, so the same string is safe as a path suffix
 * on a filesystem and as a path segment in an S3 request.
 */
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * The key rule belongs to the port, not to one adapter. Every implementation
 * calls this before it maps a key onto its own namespace, so a key that is
 * refused by the filesystem store is refused by the S3 store too.
 */
export const assertSafeObjectKey = (key: string): void => {
  if (!OBJECT_KEY.test(key) || key.split("/").includes("..")) {
    throw new StoreError(`unsafe object key: ${key}`);
  }
};

/** A verification command, already split into argv. Never a shell string. */
export interface ProveCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Where the command came from, e.g. `package.json#scripts.test`. */
  readonly source: string;
}

/**
 * A snapshot of a git working tree, used to tell whether it moved across a
 * window of time. HEAD catches a ref swap; the porcelain hash catches any
 * staged or unstaged file change even when HEAD holds still.
 */
export interface GitState {
  readonly headSha: string;
  /** sha256 of `git status --porcelain` folded with `git ls-files -v`: any
      working-tree change moves it, including a file doctored on disk while
      hidden from status by a skip-worktree or assume-unchanged index bit. */
  readonly porcelainHash: string;
  /** True when the porcelain output was empty: no uncommitted changes. */
  readonly clean: boolean;
}

/**
 * One suite in a multi-suite prove run: a Go module beside a Rust crate beside
 * a package.json, each with its own command and its own exit code. A run that
 * detects one suite carries none of these; the combined ProveOutcome is the
 * single suite. A run that detects several carries one per suite.
 */
export interface SuiteOutcome {
  /** Display form of the argv, e.g. `go test ./...`. */
  readonly command: string;
  /** Which manifest named it, e.g. `go.mod` or `package.json#scripts.test`. */
  readonly source: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly logTail: string;
  /**
   * Set when the suite was detected but did not run, e.g. its runner binary is
   * missing. A skipped suite is never a pass: the combined conclusion states it
   * and cannot go green while one suite went unproven.
   */
  readonly skipped?: string;
}

export interface ProveOutcome {
  /** Display form of the argv, for humans and for the ProofRef label. */
  readonly command: string;
  readonly source: string;
  readonly cwd: string;
  readonly repo: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Last lines of merged stdout/stderr. What a Check body and a row can hold. */
  readonly logTail: string;
  /** The whole captured output, capped by the runner. Kept as a blob, not a row. */
  readonly log: string;
  readonly startedAt: string;
  /** HEAD of the checkout when prove ran, or null when cwd is not a git repo. */
  readonly headSha: string | null;
  /** True when the checkout had no uncommitted changes when prove ran. */
  readonly porcelainClean: boolean;
  /**
   * Set when prove refused to run: the reason, in plain words. The command did
   * not execute, so the verdict is neutral, never success. Left unset on a run
   * that actually ran, whatever its exit code.
   */
  readonly refused?: string;
  /**
   * Per-suite breakdown, set only when more than one suite ran. The top-level
   * fields above are the combined view: exitCode is non-zero if any suite
   * failed, durationMs is the sum, logTail is the joined tails. A single-suite
   * run leaves this unset and every surface renders it exactly as before.
   */
  readonly suites?: readonly SuiteOutcome[];
  /**
   * The manifests prove examined when it found no suite to run. Lets the Check
   * name what it probed (package.json, go.mod, Makefile, ...) instead of a bare
   * "nothing ran". Set only on the no-command outcome, alongside `refused`.
   */
  readonly probed?: readonly string[];
}

/**
 * Runs the target repo's own verification command and reports what happened.
 * `run` is a trust boundary: it refuses unless the checkout at `cwd` is the
 * repo named by `expectRepo`, so a review of someone else's PR can never
 * execute anything in the operator's tree. It refuses a second way when
 * `baseline` is set and the tree moved since that snapshot: prove will not
 * measure a checkout that changed under it while the analysis stage ran.
 */
export interface ProvePort {
  readonly detect: (cwd: string) => Effect.Effect<ProveCommand | null, StoreError>;
  /** `owner/repo` of the checkout at `cwd`, or null when it is not a GitHub clone. */
  readonly repoAt: (cwd: string) => Effect.Effect<string | null, StoreError>;
  readonly run: (input: {
    cwd: string;
    expectRepo: string;
    timeoutMs?: number;
    /** Working-tree snapshot from before the analysis stage. When the tree
        differs by prove time, run refuses and returns a neutral outcome. */
    baseline?: GitState | null;
  }) => Effect.Effect<ProveOutcome, StoreError>;
}

/**
 * One inline annotation on a Check Run, already resolved and safe to post.
 * `path` and the lines are validated against the PR head by the caller, so the
 * adapter posts them verbatim: it never resolves or clamps a line itself.
 * `annotationLevel` is GitHub's own vocabulary, derived from the risk severity.
 */
export interface CheckAnnotation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly annotationLevel: "notice" | "warning" | "failure";
  /** <= 64KB, verbatim-derived from the risk text. */
  readonly message: string;
  /** <= 255 chars. */
  readonly title?: string;
}

export interface CheckRunInput {
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly name: string;
  readonly conclusion: "success" | "failure" | "neutral";
  readonly title: string;
  readonly summary: string;
  /**
   * Inline annotations, already resolved to changed lines and capped by the
   * caller. The adapter batches them to GitHub's 50-per-call limit and posts
   * them as-is. Absent or empty means a Check with no annotations.
   */
  readonly annotations?: readonly CheckAnnotation[];
  /** Where the Check's "Details" links: the proof page, else the workflow run. */
  readonly detailsUrl?: string;
}

/** Posts the review outcome as a GitHub Check Run. */
export interface CheckPort {
  readonly postCheckRun: (
    input: CheckRunInput,
  ) => Effect.Effect<{ posted: boolean; url: string | null }, StoreError>;
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
