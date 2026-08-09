import type { Understanding } from "@cyclops/domain";
import type { CheckRunInput, ProveOutcome } from "@cyclops/ports";
import { isProveRef } from "./prove";

export const CHECK_NAME = "cyclops / behavior-proof";

/** GitHub caps a check summary at 65535 chars; stay well under with room to spare. */
const LOG_CHARS = 8_000;
const LOG_LINES = 40;

const condense = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const logExcerpt = (o: ProveOutcome): string =>
  o.logTail.split("\n").slice(-LOG_LINES).join("\n").slice(-LOG_CHARS);

/**
 * The `post` verb: the review outcome as a Check Run body. The conclusion is
 * the prove exit code and nothing else. An Understanding without a run is
 * `neutral`, never a green check.
 *
 * Copy follows STYLE.md: plain labels, short sentences, no em dash. The
 * Understanding's own prose is normalized in @cyclops/domain when it decodes.
 */
export const behaviorProofCheck = (input: {
  understanding: Understanding;
  outcome: ProveOutcome | null;
  /** Hosted proof page for this run, when one has been published. */
  proofPageUrl?: string;
  runId?: string;
}): Omit<CheckRunInput, "owner" | "repo" | "headSha"> => {
  const { understanding: u, outcome, proofPageUrl, runId } = input;
  const conclusion = outcome === null ? "neutral" : outcome.exitCode === 0 ? "success" : "failure";
  const title =
    outcome === null
      ? "No proof was run. Understanding only."
      : outcome.timedOut
        ? `Proof timed out: ${outcome.command}`
        : outcome.exitCode === 0
          ? `Proof passed: ${outcome.command}`
          : `Proof failed: ${outcome.command} (exit ${outcome.exitCode})`;

  const reviewerRisks = u.risks.filter((r) => r.source === "reviewer").length;
  const otherRefs = u.proof_refs.filter((r) => !isProveRef(r));

  const lines = [
    `**What changed:** ${condense(u.what, 400)}`,
    "",
    `**Why:** ${condense(u.why, 400)}`,
    "",
    `**How:** ${condense(u.how, 600)}`,
    "",
    `**Risks:** ${u.risks.length} in total. ${reviewerRisks} found by review.`,
    "",
    "## Proof",
    "",
  ];

  if (outcome === null) {
    lines.push(
      "Nothing was run to check this change. This check proves nothing about behavior.",
    );
  } else {
    lines.push(
      `\`${outcome.command}\` ran in \`${outcome.repo}\` and exited **${outcome.exitCode}**${outcome.timedOut ? " (timed out)" : ""} after ${(outcome.durationMs / 1000).toFixed(1)}s.`,
      "",
      `Command source: \`${outcome.source}\``,
      "",
      "<details><summary>Log tail</summary>",
      "",
      "```",
      logExcerpt(outcome),
      "```",
      "",
      "</details>",
    );
  }

  if (otherRefs.length > 0) {
    lines.push("", "### Other evidence", "");
    for (const r of otherRefs) {
      lines.push(`- \`${r.kind}\` ${r.label}: ${condense(r.value, 200)}`);
    }
  }

  lines.push(
    "",
    proofPageUrl
      ? `[Full proof page](${proofPageUrl})`
      : "_This run has no hosted proof page. Set `PROOF_PAGE_URL` to link one._",
  );
  if (runId) lines.push("", `<sub>cyclops run \`${runId}\`</sub>`);

  return { name: CHECK_NAME, conclusion, title, summary: lines.join("\n") };
};
