import {
  DIFF_BUDGET_CHARS,
  diffCoveragePercent,
  proofVerdict,
  type RiskSeverity,
  type Understanding,
} from "@verit/domain";
import type { CheckAnnotation, CheckRunInput, ProveOutcome, SuiteOutcome } from "@verit/ports";
import { isProveRef } from "./prove";

export const CHECK_NAME = "verit / behavior-proof";

/** GitHub caps a check summary at 65535 chars; stay well under with room to spare. */
const LOG_CHARS = 8_000;
const LOG_LINES = 40;

/** GitHub's own caps on an annotation: message body and title. */
const ANNOTATION_MESSAGE_MAX = 65_536;
const ANNOTATION_TITLE_MAX = 255;
/** How many annotations one run may post. Overflow is stated, never posted. */
const ANNOTATION_CAP = 25;
/** How many risks the body lists as bullets before it says "and N more". */
const RISK_BULLET_CAP = 10;

const condense = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/**
 * Truncate on a sentence boundary while keeping the original line breaks. The
 * `how` field is written as prose the author laid out; collapsing its newlines
 * or cutting it mid-word loses that shape. Cut at the last sentence terminator
 * that falls within the budget; fall back to a hard cut only when the text has
 * no sentence break at all.
 */
const truncateSentence = (text: string, max: number): string => {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  let cut = -1;
  const re = /[.!?]["')\]]?(?=\s|$)/g;
  for (let m = re.exec(slice); m !== null; m = re.exec(slice)) {
    cut = m.index + m[0].length;
  }
  return cut > 0 ? t.slice(0, cut) : `${slice.trimEnd()}…`;
};

const tailExcerpt = (logTail: string): string =>
  logTail.split("\n").slice(-LOG_LINES).join("\n").slice(-LOG_CHARS);

const logExcerpt = (o: ProveOutcome): string => tailExcerpt(o.logTail);

/* --------------------------------- risks ---------------------------------- */

/** Loudest first, stable within a level, so the annotation cap keeps the risks
    that matter and the bullet list leads with them. */
const severityRank = (s?: RiskSeverity): number => (s === "high" ? 0 : s === "info" ? 2 : 1);

/** GitHub's annotation vocabulary, from the risk severity. Absent reads as warn. */
const annotationLevel = (s?: RiskSeverity): CheckAnnotation["annotationLevel"] =>
  s === "high" ? "failure" : s === "info" ? "notice" : "warning";

/**
 * Reviewer risks that carry a location the PR head actually changed, rendered
 * as annotations. Enforced by construction:
 * - only `source: "reviewer"` risks with a file and line are considered;
 * - the (path, line) must be in `changedLines`, the PR head's changed lines,
 *   or the anchor is DROPPED, never nudged to a nearby line;
 * - message and title are capped to GitHub's limits.
 * The caller caps the count; this returns every resolvable one so the caller
 * can state the overflow.
 */
const resolvableAnnotations = (
  sortedRisks: readonly Understanding["risks"][number][],
  changedLines: ReadonlyMap<string, ReadonlySet<number>> | undefined,
): CheckAnnotation[] => {
  if (!changedLines) return [];
  const out: CheckAnnotation[] = [];
  for (const r of sortedRisks) {
    if (r.source !== "reviewer" || r.file == null || r.line == null) continue;
    if (!changedLines.get(r.file)?.has(r.line)) continue;
    out.push({
      path: r.file,
      startLine: r.line,
      endLine: r.line,
      annotationLevel: annotationLevel(r.severity),
      message: r.note.slice(0, ANNOTATION_MESSAGE_MAX),
      title: `verit: ${r.area}`.slice(0, ANNOTATION_TITLE_MAX),
    });
  }
  return out;
};

const riskBullet = (r: Understanding["risks"][number]): string => {
  const sev = r.severity ? `**[${r.severity}]** ` : "";
  const loc = r.file != null ? ` (\`${r.file}\`${r.line != null ? `:${r.line}` : ""})` : "";
  return `- ${sev}${r.area}: ${condense(r.note, 200)}${loc}`;
};

/* ------------------------------ prove verdict ----------------------------- */

const suiteFailed = (s: SuiteOutcome): boolean =>
  s.skipped == null && (s.timedOut || s.exitCode !== 0);
const suiteSkipped = (s: SuiteOutcome): boolean => s.skipped != null;

/** One honest conclusion across suites: any failure fails, any skip stays
    neutral, all-pass succeeds. */
const multiSuiteVerdict = (
  suites: readonly SuiteOutcome[],
): "success" | "failure" | "neutral" =>
  suites.some(suiteFailed) ? "failure" : suites.some(suiteSkipped) ? "neutral" : "success";

const multiSuiteTitle = (suites: readonly SuiteOutcome[]): string => {
  const failed = suites.filter(suiteFailed).length;
  const skipped = suites.filter(suiteSkipped).length;
  if (failed > 0) return `Proof failed: ${failed} of ${suites.length} suites failed`;
  if (skipped > 0) return `Proof incomplete: ${skipped} of ${suites.length} suites did not run`;
  return `Proof passed: all ${suites.length} suites`;
};

/**
 * The `post` verb: the review outcome as a Check Run body.
 *
 * The conclusion is honest or it is nothing:
 * - No Understanding (the lane failed): `neutral`, whatever the tests said.
 *   The prove result still reports its own pass or fail inside the body.
 * - An Understanding without a prove run: `neutral`, never a green check.
 * - Both present: the prove exit code decides, except a run whose analysis
 *   only covered part of the diff caps success at `neutral`. Several suites
 *   combine into one verdict: any failure fails, any skip stays neutral.
 * - Gating (`failOn: "failure"`): a required check counts `neutral` as a pass,
 *   so under gating an inconclusive proof (nothing ran, refused, no command,
 *   or partial) maps to `failure` instead of quietly passing.
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
  /** Fallback for the Check's Details link when there is no proof page. */
  workflowRunUrl?: string;
  /** The PR head's changed lines, per path, from @verit/netdiff. An annotation
      may only anchor to a line in here. */
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
  /** Required-check gating. `failure` maps an inconclusive proof to failure so
      it cannot pass as a neutral check. `never` (default) is today's behavior. */
  failOn?: "failure" | "never";
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
  const {
    understanding: u,
    outcome,
    diffChars,
    proofPageUrl,
    workflowRunUrl,
    changedLines,
    failOn = "never",
    runId,
    forceNeutral,
  } = input;
  const frozen = forceNeutral !== undefined && forceNeutral.trim() !== "";
  const coverage = diffChars === undefined ? 100 : diffCoveragePercent(diffChars);

  const sortedRisks = u === null
    ? []
    : [...u.risks].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const resolvable = resolvableAnnotations(sortedRisks, changedLines);
  const annotations = resolvable.slice(0, ANNOTATION_CAP);
  const annotationOverflow = resolvable.length - annotations.length;

  const uncapped =
    u === null
      ? "neutral"
      : outcome?.refused != null
        ? "neutral"
        : outcome?.suites && outcome.suites.length > 0
          ? multiSuiteVerdict(outcome.suites)
          : proofVerdict(outcome);
  // partial analysis never turns green, however loudly the tests passed
  const capped = uncapped === "success" && coverage < 100 ? "neutral" : uncapped;
  // gating: a neutral check passes required checks, so under fail-on=failure an
  // inconclusive proof must fail rather than pass silently.
  const gated = failOn === "failure" && capped === "neutral";
  // freeze is the incident lever: it forces no-claim and can only downgrade a
  // claim, never invent one, so it is the last word and overrides gating too
  // (leaving it on can never turn a check into failure).
  const conclusion = frozen ? "neutral" : gated ? "failure" : capped;

  const proofTitle =
    outcome === null
      ? "No proof was run."
      : outcome.probed != null
        ? `No test command found. ${outcome.probed.length} manifest(s) probed.`
        : outcome.refused != null
          ? "Proof did not run."
          : outcome.suites && outcome.suites.length > 0
            ? multiSuiteTitle(outcome.suites)
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
      `**How:** ${truncateSentence(u.how, 600)}`,
      "",
      `**Risks:** ${u.risks.length} in total, ${reviewerRisks} found by review.`,
    );
    if (u.risks.length > 0) {
      for (const r of sortedRisks.slice(0, RISK_BULLET_CAP)) lines.push(riskBullet(r));
      const extra = sortedRisks.length - RISK_BULLET_CAP;
      if (extra > 0) lines.push(`- and ${extra} more.`);
    }
    if (annotations.length > 0) {
      lines.push(
        "",
        `${annotations.length} located ${annotations.length === 1 ? "risk is" : "risks are"} marked inline as annotations.`,
      );
    }
    if (annotationOverflow > 0) {
      lines.push(
        `${annotationOverflow} more located ${annotationOverflow === 1 ? "risk exceeds" : "risks exceed"} the ${ANNOTATION_CAP}-annotation cap and stay in the list above.`,
      );
    }
    lines.push("");
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
  } else if (outcome.probed != null) {
    lines.push(
      "No test command was found in the checkout, so nothing ran. This check proves nothing about behavior.",
      "",
      `Probed: ${outcome.probed.join(", ")}.`,
      "",
      "Set `VERIT_PROVE_CMD` to name a command, or add a recognized manifest.",
    );
  } else if (outcome.refused != null) {
    lines.push(
      `The proof did not run because ${outcome.refused}`,
      "",
      `Workspace: HEAD \`${outcome.headSha ?? "unknown"}\` when prove checked.`,
    );
  } else if (outcome.suites && outcome.suites.length > 0) {
    const suites = outcome.suites;
    const failed = suites.filter(suiteFailed).length;
    const skipped = suites.filter(suiteSkipped).length;
    lines.push(
      `${suites.length} suites ran in \`${outcome.repo}\`. ${failed} failed, ${skipped} skipped.`,
      "",
      `Workspace: HEAD \`${outcome.headSha ?? "unknown"}\`, working tree ${outcome.porcelainClean ? "clean" : "dirty"} at prove time.`,
      "",
    );
    if (skipped > 0) {
      lines.push(
        "A skipped suite did not run, so this check stays neutral until every suite runs.",
        "",
      );
    }
    for (const s of suites) {
      const status =
        s.skipped != null
          ? `skipped: ${s.skipped}`
          : s.timedOut
            ? `timed out after ${(s.durationMs / 1000).toFixed(1)}s (exit ${s.exitCode})`
            : `exit ${s.exitCode} after ${(s.durationMs / 1000).toFixed(1)}s`;
      lines.push(
        `### ${s.command}`,
        "",
        `Source: \`${s.source}\`. ${status}.`,
        "",
        "<details><summary>Log tail</summary>",
        "",
        "```",
        tailExcerpt(s.logTail),
        "```",
        "",
        "</details>",
        "",
      );
    }
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

  if (gated) {
    lines.push(
      "",
      "This check is gated: fail-on is set to failure, so a run with no honest passing proof fails here instead of passing as a neutral check.",
    );
  }

  const otherRefs = u === null ? [] : u.proof_refs.filter((r) => !isProveRef(r));
  if (otherRefs.length > 0) {
    lines.push("", "### Other evidence", "");
    for (const r of otherRefs) {
      lines.push(`- \`${r.kind}\` ${r.label}: ${condense(r.value, 200)}`);
    }
  }

  const detailsUrl = proofPageUrl ?? workflowRunUrl;
  if (proofPageUrl) {
    lines.push("", `[Full proof page](${proofPageUrl})`);
  }
  if (runId) lines.push("", `<sub>verit run \`${runId}\`</sub>`);

  return {
    name: CHECK_NAME,
    conclusion,
    title,
    summary: lines.join("\n"),
    annotations: annotations.length > 0 ? annotations : undefined,
    detailsUrl,
  };
};
