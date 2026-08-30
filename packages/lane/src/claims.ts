import { Effect, Either, JSONSchema, Schema as S } from "effect";
import { type Claim, type ClaimSources, groundClaims } from "@verit/domain";
import type { LaneClient, LaneRequest, LaneTool } from "./client";

/*
 * Claim extraction.
 *
 * The model proposes; the code decides. A pass here returns statements with the
 * exact spans they were drawn from, and every one of those spans is then
 * checked against the material by `groundClaims`. A claim quoting a sentence
 * nobody wrote comes back ambiguous no matter how the model scored it, and an
 * ambiguous claim is what asks the author for one line rather than what lets
 * the run continue quietly.
 *
 * Failure here is never a fabricated claim. A model call that errors, times
 * out, or returns junk yields no claims at all, and the readiness policy turns
 * that into needs-claim.
 */

export const CLAIMS_TOOL_NAME = "submit_claims";

const ProposedAnchor = S.Struct({
  kind: S.Literal("issue", "pr-description", "diff", "repo-context"),
  /** Where the material lives: an issue number, a file path, a hunk header. */
  ref: S.String.pipe(S.minLength(1)),
  /** The quoted span, copied character for character from that material. */
  span: S.String.pipe(S.minLength(1)),
});

const ProposedClaim = S.Struct({
  /** One behavior, stated so that a run could contradict it. */
  statement: S.String.pipe(S.minLength(1)),
  anchors: S.Array(ProposedAnchor),
  confidence: S.Number.pipe(S.between(0, 1)),
  /** Paths or hunk headers from the diff this claim covers. */
  regions: S.Array(S.String),
});

export const ClaimSubmission = S.Struct({
  claims: S.Array(ProposedClaim),
});
export type ClaimSubmission = S.Schema.Type<typeof ClaimSubmission>;

const decodeClaimSubmission = S.decodeUnknownEither(ClaimSubmission);

/** Generated from the Schema so the tool contract and the decode cannot drift. */
export const claimsJsonSchema = (): Record<string, unknown> => {
  const schema = JSON.parse(JSON.stringify(JSONSchema.make(ClaimSubmission))) as Record<
    string,
    unknown
  >;
  delete schema["$schema"];
  return schema;
};

const claimsTool = (): LaneTool => ({
  name: CLAIMS_TOOL_NAME,
  description:
    "Submit the behavioral claims this pull request makes. Call exactly once, then stop.",
  inputSchema: claimsJsonSchema(),
});

const CLAIMS_SYSTEM = `You read a pull request and name the behavioral claims it makes.

A claim is one sentence about behavior that a test run could contradict. "Parsing a trailing comma no longer throws" is a claim. "Refactors the parser" is not: nothing could contradict it.

Every claim must carry anchors. An anchor quotes the exact text you drew the claim from, copied character for character from the issue, the pull request description, or the diff you were given. Never paraphrase inside an anchor and never quote text you did not see. A claim you cannot anchor is one you should not submit.

State your confidence honestly. A low number costs nothing: it asks the author to say what the change does. A high number on a claim you invented is the worst thing you can do here.

Call ${CLAIMS_TOOL_NAME} exactly once with the claims, then stop. Submit an empty list if the change makes no behavioral claim you can anchor.`;

const CLAIMS_MAX_TOKENS = 4_000;

const log = (message: string): void => console.error(`[verit-lane] ${message}`);

/** Render the material the model reads. The anchors are checked against it. */
export const renderClaimSources = (sources: ClaimSources): string => {
  const parts: string[] = [];
  if (sources.issue !== undefined && sources.issue !== "") {
    parts.push(`ISSUE:\n${sources.issue}`);
  }
  if (sources.prDescription !== undefined && sources.prDescription !== "") {
    parts.push(`PULL REQUEST DESCRIPTION:\n${sources.prDescription}`);
  }
  if (sources.repoContext !== undefined && sources.repoContext !== "") {
    parts.push(`REPOSITORY CONTEXT:\n${sources.repoContext}`);
  }
  parts.push(`NET DIFF:\n${sources.diff}`);
  return parts.join("\n\n");
};

/**
 * One model call, then a decode, then the grounding check.
 *
 * Never throws and never invents. Every failure path returns an empty list,
 * which readiness reports as needs-claim: verit asking for a sentence is always
 * better than verit guessing one.
 */
export const runClaimPass = async (
  client: LaneClient,
  sources: ClaimSources,
): Promise<readonly Claim[]> => {
  let submission: ClaimSubmission;
  try {
    const request: LaneRequest = {
      system: CLAIMS_SYSTEM,
      messages: [{ role: "user", content: renderClaimSources(sources) }],
      tools: [claimsTool()],
      maxTokens: CLAIMS_MAX_TOKENS,
      forceTool: CLAIMS_TOOL_NAME,
    };
    const outcome = await Effect.runPromise(Effect.either(client.complete(request)));
    if (Either.isLeft(outcome)) {
      log(`claim pass failed, this run has no claims: ${outcome.left.message}`);
      return [];
    }
    const call = outcome.right.toolCalls.find((c) => c.name === CLAIMS_TOOL_NAME);
    if (call === undefined) {
      log("claim pass submitted no claims");
      return [];
    }
    const decoded = decodeClaimSubmission(call.input);
    if (Either.isLeft(decoded)) {
      log("claim pass output was invalid, this run has no claims");
      return [];
    }
    submission = decoded.right;
  } catch (error) {
    log(`claim pass errored: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const proposed: Claim[] = submission.claims.map((c, i) => ({
    id: `claim:${i + 1}`,
    statement: c.statement,
    state: "proposed" as const,
    anchors: [...c.anchors],
    modelConfidence: c.confidence,
    regions: [...c.regions],
  }));

  // The decision is here, not in the model: every anchor is checked against the
  // material it names before a claim can count as grounded.
  return groundClaims(proposed, sources);
};

/** True when verit should ask the author to state the behavior in one line. */
export const needsAuthorClaim = (claims: readonly Claim[]): boolean =>
  claims.length === 0 || claims.some((c) => c.state === "ambiguous");
