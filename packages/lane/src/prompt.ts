import { OUTPUT_STYLE, UNDERSTANDING_JSON_SHAPE } from "@verit/domain";
import { diffSection } from "@verit/netdiff";
import type { HarnessPort } from "@verit/ports";
import { modeReviews, reviewInstructions, type LaneMode, type ProofStatus } from "./review";

export type UnderstandInput = Parameters<HarnessPort["runUnderstand"]>[0];

/** Body budget only, shared with the pi lane. The diff budget lives in
    @verit/netdiff's diffSection: moves netted out first, coverage in step. */
const MAX_BODY = 8_000;

export const SUBMIT_TOOL_NAME = "submit_understanding";

/**
 * The one system prompt of the thin lane. Everything harness-shaped lives
 * here; the user message carries only the PR itself.
 *
 * Mode drives what gets appended. "understanding" (the default) returns the
 * summarize-only prompt byte for byte as it was before review existed. "review"
 * and "both" append the finding-hunting block, so the judge fills the same
 * risks[] with located reviewer findings the skeptic then verifies.
 */
export const laneSystemPrompt = (
  role: UnderstandInput["role"],
  mode: LaneMode = "understanding",
  proofStatus: ProofStatus = "neutral",
): string => {
  const base = `You are the ${role} lane behind verit, a behaviour proof review tool.

Produce the Understanding of one pull request: what it changes, why, how a human can verify the behaviour, and where the risk is. The user message carries the PR. The diff is the ground truth.

You have tools: read_file, list_dir, grep, and bash, running in a checkout that may not match the PR's repo or revision. Use them to confirm context around the changed code. When the tree disagrees with the diff, trust the diff. The bash environment is scrubbed: no API keys, no tokens, no network credentials. Keep tool use targeted; a handful of reads beats a crawl.

${OUTPUT_STYLE}

When your analysis is complete, call ${SUBMIT_TOOL_NAME} exactly once with the final Understanding. The shape, for reference:
${UNDERSTANDING_JSON_SHAPE}
- Every file path and code excerpt must come verbatim from the diff or from tool output. Never invent one.`;
  return modeReviews(mode) ? `${base}\n\n${reviewInstructions(mode, proofStatus)}` : base;
};

const list = (items: readonly string[], max: number, empty: string): string =>
  items.length === 0 ? empty : items.slice(0, max).join("\n");

/** The PR as the model sees it. Same budgets and sections as the pi lane. */
export const laneUserPrompt = (input: UnderstandInput): string => {
  const { title, body, paths, diff, context } = input;
  const wiki = context.wiki_hits
    .slice(0, 3)
    .map((h) => `${h.title}: ${h.excerpt.slice(0, 120)}`);
  const neighbours = context.pr_graph
    .slice(0, 3)
    .map((n) => `#${n.number} ${n.title} (${n.edgeKind})`);

  return `TITLE: ${title}

DESCRIPTION:
${body.slice(0, MAX_BODY) || "(empty)"}

CHANGED PATHS (${paths.length}):
${list(paths, 200, "(none listed)")}

REVIEW CONTEXT: domain=${context.domain}, focus=${context.focus ?? "none"}
RELATED WIKI:
${list(wiki, 3, "(none indexed)")}
RELATED PULL REQUESTS:
${list(neighbours, 3, "(none)")}

${diffSection(diff)}`;
};
