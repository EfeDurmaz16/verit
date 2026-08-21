import {
  DIFF_BUDGET_CHARS,
  diffCoveragePercent,
  proofVerdict,
  type Understanding,
} from "@verit/domain";
import type { CheckRunInput, ProveOutcome } from "@verit/ports";
import { isProveRef } from "./prove";

export const CHECK_NAME = "verit / behavior-proof";

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
 * The `post` verb: the review outcome as a Check Run body.
 *
 * The conclusion is honest or it is nothing:
 * - No Understanding (the lane failed): `neutral`, whatever the tests said.
 *   The prove result still reports its own pass or fail inside the body.
 * - An Understanding without a prove run: `neutral`, never a green check.
 * - Both present: the prove exit code decides, except a run whose analysis
 *   only covered part of the diff caps success at `neutral`.
 *
 * Copy follows STYLE.md: plain labels, short sentences, no em dash. The
 * Understanding's own prose is normalized in @verit/domain when it decodes.
 */
export const behaviorProofCheck = (input: {
  /** Null when the lane did not complete. Analysis is then absent, not faked. */
  understanding: Understanding | null;
  outcome: ProveOutcome | null;
  /** Net size of the reviewed diff in chars, code moves factored out by
      @verit/netdiff. Beyond the budget the analysis is partial. */
  diffChars?: number;
  /** Hosted proof page for this run, when one has been published. */
  proofPageUrl?: string;
  runId?: string;
  /**
   * The incident freeze lever. When set to a reason, the check concludes
   * neutral no matter what the proof said. This is the "force the affected
   * path to no-claim" mechanism the false-green runbook drill uses: an operator
   * sets VERIT_FORCE_NEUTRAL to stop a bad path from ever claiming green while
   * the root cause is being fixed. It can only downgrade a claim, never invent
   * one, so it is always safe to leave on.
   */
  forceNeutral?: string;
}): Omit<CheckRunInput, "owner" | "repo" | "headSha"> => {
  const { understanding: u, outcome, diffChars, proofPageUrl, runId, forceNeutral } = input;
  const frozen = forceNeutral !== undefined && forceNeutral.trim() !== "";
  const coverage = diffChars === undefined ? 100 : diffCoveragePercent(diffChars);
  const uncapped = u === null ? "neutral" : proofVerdict(outcome);
  // partial analysis never turns green, however loudly the tests passed; and a
  // freeze forces neutral over everything, since a suspected false green must
  // not claim anything until the root cause is shipped.
  const conclusion = frozen
    ? "neutral"
    : uncapped === "success" && coverage < 100
      ? "neutral"
      : uncapped;
  const proofTitle =
    outcome === null
      ? "No proof was run."
      : outcome.refused != null
        ? "Proof did not run: the working tree changed during analysis."
        : outcome.timedOut
          ? `Proof timed out: ${outcome.command}`
          : outcome.exitCode === 0
            ? `Proof passed: ${outcome.command}`
            : `Proof failed: ${outcome.command} (exit ${outcome.exitCode})`;
  const title = frozen
    ? `Frozen to no-claim: ${condense(forceNeutral ?? "", 120)}`
    : u === null
      ? `Analysis did not complete. ${proofTitle}`
      : outcome === null
        ? "No proof was run. Understanding only."
        : proofTitle;

  const lines: string[] = [];
  if (frozen) {
    lines.push(
      `**Frozen.** An operator forced this check to no-claim: ${condense(forceNeutral ?? "", 400)}`,
      "",
      "The proof result below still shows what ran. The conclusion stays neutral until the freeze is lifted.",
      "",
    );
  }
  if (u === null) {
    lines.push(
      "Analysis did not complete. No Understanding was produced for this run, so this check stays neutral whatever the tests say.",
      "",
    );
  } else {
    const reviewerRisks = u.risks.filter((r) => r.source === "reviewer").length;
    lines.push(
      `**What changed:** ${condense(u.what, 400)}`,
      "",
      `**Why:** ${condense(u.why, 400)}`,
      "",
      `**How:** ${condense(u.how, 600)}`,
      "",
      `**Risks:** ${u.risks.length} in total. ${reviewerRisks} found by review.`,
      "",
    );
  }
  if (coverage < 100 && diffChars !== undefined) {
    lines.push(
      `**Coverage:** reviewed ${coverage}% of the net diff, code moves factored out (${DIFF_BUDGET_CHARS} of ${diffChars} net chars). Analysis is partial, so a passing proof caps this check at neutral.`,
      "",
    );
  }
  lines.push("## Proof", "");

  if (outcome === null) {
    lines.push(
      "Nothing was run to check this change. This check proves nothing about behavior.",
    );
  } else if (outcome.refused != null) {
    lines.push(
      `The proof did not run because ${outcome.refused}`,
      "",
      `Workspace: HEAD \`${outcome.headSha ?? "unknown"}\` when prove checked.`,
    );
  } else {
    lines.push(
      `\`${outcome.command}\` ran in \`${outcome.repo}\` and exited **${outcome.exitCode}**${outcome.timedOut ? " (timed out)" : ""} after ${(outcome.durationMs / 1000).toFixed(1)}s.`,
      "",
      `Workspace: HEAD \`${outcome.headSha ?? "unknown"}\`, working tree ${outcome.porcelainClean ? "clean" : "dirty"} at prove time.`,
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
    if (outcome.exitCode === 0 && coverage < 100) {
      lines.push(
        "",
        "The tests passed. The analysis is partial. Those are different claims, so the conclusion stays neutral.",
      );
    }
  }

  const otherRefs = u === null ? [] : u.proof_refs.filter((r) => !isProveRef(r));
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
  if (runId) lines.push("", `<sub>verit run \`${runId}\`</sub>`);

  return { name: CHECK_NAME, conclusion, title, summary: lines.join("\n") };
};
