import { Either, Schema as S } from "effect";

/**
 * House style for every string a reviewer reads. STYLE.md at the repo root is
 * the contract; this constant is the copy every prompt surface ships to the
 * model. Keep the two in sync.
 */
export const OUTPUT_STYLE = `OUTPUT STYLE, this is not optional:
- Write so a busy reviewer can scan it in under a minute.
- Never use the em dash character. Use a period, a comma, or a colon instead.
- Short sentences. One idea each. Break a long sentence into two.
- Active voice. Say who or what does the thing: "the route handler retries", not "retries are performed".
- Short words over long ones. Cut any word that carries no meaning.
- Name concrete files, functions, and behaviors, not abstractions like "the system".
- No filler openers: no "notably", "importantly", "it is worth noting", "this PR aims to".
- No hype and no praise. State what the code does, including the parts that look wrong.
- Plain words over jargon. Keep a technical term only when it names something exact.`;

/**
 * The Understanding a lane must produce, as the model sees it. Every harness
 * ships this same block, so the workspace lane and the Action lane are judged
 * against one contract instead of two that drift apart silently.
 */
export const UNDERSTANDING_JSON_SHAPE = `{
  "what":  "<one paragraph: what this PR actually changes in behaviour>",
  "why":   "<one paragraph: why the change exists>",
  "how":   "<one paragraph: how it is implemented, naming the load-bearing files>",
  "proof_refs": [ {"kind":"test|command|url|image|video","label":"<what it proves>","value":"<verbatim test name, command, or URL>"} ],
  "out_of_scope": [ "<something a reviewer might expect that this PR does not do>" ],
  "risks": [ {"area":"<short slug>","note":"<one sentence>","source":"reviewer|author"} ]
}
Rules:
- what, why and how are required and must each be non-empty. The output is validated against a
  strict schema. If it fails, the run is reported as unverified.
- Every proof_ref must be runnable or openable as written. An empty list beats an invented one.
- source:"author" is for risks the PR description itself admits. source:"reviewer" is for risks you
  found by reading the diff. The author's list is a hint, NEVER an allowlist. Review the whole diff
  whatever the description says, and expect to find risks the author did not mention.
- Every string follows the OUTPUT STYLE above. No em dash anywhere.`;

/** Closed review specialty enum, not technology stacks. */
export const ReviewDomain = S.Literal(
  "GENERAL",
  "ARCHITECTURE",
  "BACKEND",
  "FRONTEND",
  "UI_UX",
  "API",
  "DATABASE",
  "PERFORMANCE",
  "SECURITY",
  "RELIABILITY",
  "CONCURRENCY",
  "TESTING",
  "OBSERVABILITY",
  "INFRASTRUCTURE",
  "DEVOPS",
  "PAYMENTS",
  "CRYPTO",
  "AI",
  "DATA",
  "MOBILE",
  "DOCUMENTATION",
  "DEVELOPER_EXPERIENCE",
  "ACCESSIBILITY",
);
export type ReviewDomain = S.Schema.Type<typeof ReviewDomain>;

export const ProofRefKind = S.Literal("test", "command", "url", "image", "video");
export type ProofRefKind = S.Schema.Type<typeof ProofRefKind>;

/**
 * A pointer to evidence. `status` and `log` are only set by refs that were
 * actually executed (see the prove verb): a ref carrying `status: "fail"`
 * renders as a failure everywhere, and nothing may drop it to dress a run up.
 */
export const ProofRef = S.Struct({
  kind: ProofRefKind,
  label: S.String,
  value: S.String,
  status: S.optional(S.Literal("pass", "fail")),
  log: S.optional(S.String),
});
export type ProofRef = S.Schema.Type<typeof ProofRef>;

export const RiskItem = S.Struct({
  area: S.String,
  note: S.String,
  source: S.optional(S.Literal("author", "reviewer", "classifier")),
});
export type RiskItem = S.Schema.Type<typeof RiskItem>;

/**
 * Canonical Understanding artifact.
 * Author `risks` are hints only, never an allowlist for review agents.
 */
export const Understanding = S.Struct({
  what: S.String.pipe(S.minLength(1)),
  why: S.String.pipe(S.minLength(1)),
  how: S.String.pipe(S.minLength(1)),
  proof_refs: S.Array(ProofRef),
  out_of_scope: S.optional(S.Array(S.String)),
  risks: S.Array(RiskItem),
});
export type Understanding = S.Schema.Type<typeof Understanding>;

/**
 * The prompt bans the em dash, but a model can still emit one. Strip it at the
 * one boundary every Understanding passes through, so no downstream surface
 * (Check Run body, proof page, workspace) has to care.
 *
 * Rule: an em dash and the whitespace around it become ", ". That reads as the
 * aside it almost always was. A trailing comma left at the end is dropped.
 */
export const plainText = (s: string): string =>
  s.includes("—")
    ? s.replace(/\s*—\s*/g, ", ").replace(/,\s*$/, "").trim()
    : s;

const normalize = (u: Understanding): Understanding => ({
  ...u,
  what: plainText(u.what),
  why: plainText(u.why),
  how: plainText(u.how),
  proof_refs: u.proof_refs.map((r) => ({ ...r, label: plainText(r.label) })),
  out_of_scope: u.out_of_scope?.map(plainText),
  risks: u.risks.map((r) => ({ ...r, note: plainText(r.note) })),
});

const decode = S.decodeUnknownEither(Understanding);

/** Decode + validate an Understanding, then normalize its prose to house style. */
export const decodeUnderstanding = (input: unknown) => Either.map(decode(input), normalize);
export const encodeUnderstanding = S.encodeUnknownEither(Understanding);

/** Focus must differ from primary when set. */
export const assertDomainFocus = (
  domain: ReviewDomain,
  focus: ReviewDomain | undefined,
): void => {
  if (focus !== undefined && focus === domain) {
    throw new Error("focus must differ from primary domain");
  }
};

export const ReviewerIdentity = S.Literal("cool", "normal", "harsh");
export type ReviewerIdentity = S.Schema.Type<typeof ReviewerIdentity>;

export const ProofFrequency = S.Literal("never", "behavior_default", "every");
export type ProofFrequency = S.Schema.Type<typeof ProofFrequency>;

export const AutomationPreset = S.Literal("off", "scheduled");
export type AutomationPreset = S.Schema.Type<typeof AutomationPreset>;

export const InlinePreset = S.Literal("off", "high_conf_only");
export type InlinePreset = S.Schema.Type<typeof InlinePreset>;

export const ReviewPresets = S.Struct({
  reviewer_identity: ReviewerIdentity,
  proof_frequency: ProofFrequency,
  codebase_automation: AutomationPreset,
  inline_comments: InlinePreset,
  domain: ReviewDomain,
  focus: S.optional(ReviewDomain),
});
export type ReviewPresets = S.Schema.Type<typeof ReviewPresets>;

export const EntityId = S.String.pipe(S.minLength(1));
export type EntityId = S.Schema.Type<typeof EntityId>;

export const Repo = S.Struct({
  id: EntityId,
  fullName: S.String,
  defaultBranch: S.optional(S.String),
});
export type Repo = S.Schema.Type<typeof Repo>;

export const FileNode = S.Struct({
  id: EntityId,
  repoId: EntityId,
  path: S.String,
  language: S.optional(S.String),
});
export type FileNode = S.Schema.Type<typeof FileNode>;

export const SymbolNode = S.Struct({
  id: EntityId,
  fileId: EntityId,
  name: S.String,
  kind: S.String,
  startLine: S.Number,
  endLine: S.Number,
});
export type SymbolNode = S.Schema.Type<typeof SymbolNode>;

export const WikiPage = S.Struct({
  id: EntityId,
  repoId: EntityId,
  path: S.String,
  title: S.String,
  body: S.String,
});
export type WikiPage = S.Schema.Type<typeof WikiPage>;

export const IndexChunk = S.Struct({
  id: EntityId,
  repoId: EntityId,
  sourceKind: S.Literal("wiki", "file"),
  sourceId: EntityId,
  text: S.String,
  embedding: S.optional(S.Array(S.Number)),
});
export type IndexChunk = S.Schema.Type<typeof IndexChunk>;

export const PullRequest = S.Struct({
  id: EntityId,
  repoId: EntityId,
  number: S.Number,
  title: S.String,
  body: S.optional(S.String),
  author: S.String,
  baseRef: S.String,
  headRef: S.String,
  url: S.String,
});
export type PullRequest = S.Schema.Type<typeof PullRequest>;

export const PREdgeKind = S.Literal(
  "closes",
  "linked",
  "same_author_path",
  "embedding_similar",
);
export type PREdgeKind = S.Schema.Type<typeof PREdgeKind>;

export const PREdge = S.Struct({
  id: EntityId,
  fromPrId: EntityId,
  toPrId: EntityId,
  kind: PREdgeKind,
  inferred: S.Boolean,
  confidence: S.optional(S.Number),
});
export type PREdge = S.Schema.Type<typeof PREdge>;

export const ReviewRun = S.Struct({
  id: EntityId,
  repoId: EntityId,
  prId: S.optional(EntityId),
  skillPackHash: S.String,
  domain: ReviewDomain,
  focus: S.optional(ReviewDomain),
  createdAt: S.String,
});
export type ReviewRun = S.Schema.Type<typeof ReviewRun>;

/** One live-workspace session: a PR at a specific head, with its blob dir. */
export const WorkspaceSession = S.Struct({
  id: EntityId,
  repo: S.String,
  prNumber: S.Number,
  headSha: S.String,
  /** Directory holding the run's blobs (diff, spec stream, understanding). */
  workdir: S.String,
  createdAt: S.String,
});
export type WorkspaceSession = S.Schema.Type<typeof WorkspaceSession>;

export const WorkspaceRunStatus = S.Literal("running", "done", "error");
export type WorkspaceRunStatus = S.Schema.Type<typeof WorkspaceRunStatus>;

/** One analysis run of a session; `reviewRunId` links to the ReviewRun it produced. */
export const WorkspaceRun = S.Struct({
  id: EntityId,
  sessionId: EntityId,
  status: WorkspaceRunStatus,
  threadId: S.NullOr(S.String),
  reviewRunId: S.NullOr(EntityId),
  error: S.NullOr(S.String),
  startedAt: S.String,
  finishedAt: S.NullOr(S.String),
});
export type WorkspaceRun = S.Schema.Type<typeof WorkspaceRun>;

export const ProofArtifact = S.Struct({
  id: EntityId,
  runId: EntityId,
  kind: S.Literal("json_render_spec", "markdown", "sandbox_log", "media"),
  contentType: S.String,
  body: S.String,
  contentHash: S.String,
});
export type ProofArtifact = S.Schema.Type<typeof ProofArtifact>;

/**
 * What `prove` actually did, as a schema. Structurally the same as ProveOutcome
 * in @cyclops/ports, which stays an interface because nothing decodes it in
 * process. This one crosses the network, so it is validated.
 */
export const ProveResult = S.Struct({
  command: S.String,
  source: S.String,
  repo: S.String,
  exitCode: S.Number,
  durationMs: S.Number,
  timedOut: S.Boolean,
  logTail: S.String,
  startedAt: S.String,
});
export type ProveResult = S.Schema.Type<typeof ProveResult>;

/**
 * The one rule that turns a prove run into a verdict. The Check Run
 * conclusion and the dashboard row read it from here, so a run cannot be green
 * on one surface and neutral on the other. No prove run is never a success.
 */
export const proofVerdict = (
  outcome: { readonly exitCode: number } | null | undefined,
): "success" | "failure" | "neutral" =>
  outcome == null ? "neutral" : outcome.exitCode === 0 ? "success" : "failure";

/** The pull request a run reviewed, as the dashboard lists it. */
export const RunUploadPr = S.Struct({
  number: S.Number.pipe(S.int(), S.positive()),
  title: S.String,
  url: S.String,
  author: S.String,
  /** Absent when the run was not driven by a checkout, e.g. a local dogfood. */
  headSha: S.optional(S.String),
});
export type RunUploadPr = S.Schema.Type<typeof RunUploadPr>;

/** One log file kept whole. The log tail lives on the run row; this is the rest. */
export const RunUploadLog = S.Struct({
  name: S.String.pipe(S.minLength(1), S.maxLength(120), S.pattern(/^[A-Za-z0-9._-]+$/)),
  contentType: S.String.pipe(S.maxLength(120)),
  body: S.String.pipe(S.maxLength(4_000_000)),
});
export type RunUploadLog = S.Schema.Type<typeof RunUploadLog>;

/** `owner/name`. The dashboard keys every repo by this and nothing else. */
export const RepoSlug = S.String.pipe(
  S.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/**
 * A finished run as the Action posts it to the dashboard. This is the whole
 * contract of the ingest endpoint. The Action encodes it, the dashboard
 * decodes it, and neither side gets to invent a field the other does not know.
 */
export const RunUpload = S.Struct({
  repo: RepoSlug,
  run: ReviewRun,
  understanding: Understanding,
  /** json-render Spec. Kept opaque past root and elements, which the page needs. */
  proofSpec: S.Struct({
    root: S.String.pipe(S.minLength(1)),
    elements: S.Record({ key: S.String, value: S.Unknown }),
  }),
  pr: S.optional(RunUploadPr),
  prove: S.optional(ProveResult),
  logs: S.optional(S.Array(RunUploadLog)),
});
export type RunUpload = S.Schema.Type<typeof RunUpload>;

export const encodeRunUpload = S.encodeUnknownEither(RunUpload);

/** Decode an uploaded run, normalizing the Understanding prose on the way in. */
export const decodeRunUpload = (input: unknown) =>
  Either.map(S.decodeUnknownEither(RunUpload)(input), (u) => ({
    ...u,
    understanding: normalize(u.understanding),
  }));

export const WikiHit = S.Struct({
  pageId: EntityId,
  title: S.String,
  excerpt: S.String,
  score: S.Number,
});
export type WikiHit = S.Schema.Type<typeof WikiHit>;

export const PrGraphNeighbor = S.Struct({
  prId: EntityId,
  number: S.Number,
  title: S.String,
  edgeKind: PREdgeKind,
  inferred: S.Boolean,
  blurb: S.String,
});
export type PrGraphNeighbor = S.Schema.Type<typeof PrGraphNeighbor>;

export const ReviewContext = S.Struct({
  wiki_hits: S.Array(WikiHit),
  pr_graph: S.Array(PrGraphNeighbor),
  domain: ReviewDomain,
  focus: S.optional(ReviewDomain),
});
export type ReviewContext = S.Schema.Type<typeof ReviewContext>;

export const CODING_SKILLS = [
  "understand",
  "plan",
  "build",
  "verify",
  "review",
  "render",
] as const;

export const REVIEW_SKILLS = [
  "understand",
  "prove",
  "risk",
  "patch",
  "render",
  "post",
] as const;

export type CodingSkill = (typeof CODING_SKILLS)[number];
export type ReviewSkill = (typeof REVIEW_SKILLS)[number];
