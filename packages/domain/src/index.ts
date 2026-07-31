import { Schema as S } from "effect";

/** Closed review specialty enum — not technology stacks. */
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

export const ProofRef = S.Struct({
  kind: ProofRefKind,
  label: S.String,
  value: S.String,
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
 * Author `risks` are hints only — never an allowlist for review agents.
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

export const decodeUnderstanding = S.decodeUnknownEither(Understanding);
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

export const ProofArtifact = S.Struct({
  id: EntityId,
  runId: EntityId,
  kind: S.Literal("json_render_spec", "markdown", "sandbox_log", "media"),
  contentType: S.String,
  body: S.String,
  contentHash: S.String,
});
export type ProofArtifact = S.Schema.Type<typeof ProofArtifact>;

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
