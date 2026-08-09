import { fetchPR, parsePrUrl } from "@/lib/gh";
import { proveReviewRun } from "@/lib/prove";
import { readStoredUnderstanding } from "@/lib/review-run";
import { sessionId } from "@/lib/sessions";
import { sessionStore } from "@/lib/stores";
import { understandingPatches } from "@/lib/understanding";
import { Effect } from "effect";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
/* prove can legitimately take minutes: it is the repo's own test suite */
export const maxDuration = 900;

/**
 * Explicit user action only. Nothing here runs on analysis, on load, or on a
 * schedule — the client calls this when someone clicks the labelled button,
 * and the runner still refuses unless this checkout is the reviewed repo.
 */
export async function POST(req: NextRequest) {
  const { url } = (await req.json()) as { url?: string };
  const parsed = parsePrUrl(url ?? "");
  if (!parsed) return NextResponse.json({ error: "bad pr url" }, { status: 400 });

  const pr = await fetchPR(parsed.repo, parsed.number);
  const run = await Effect.runPromise(sessionStore().latestRun(sessionId(pr))).catch(() => null);
  if (!run?.reviewRunId) {
    return NextResponse.json({ error: "no finished run to attach proof to" }, { status: 409 });
  }
  const understanding = await readStoredUnderstanding(run.reviewRunId);
  if (!understanding) {
    return NextResponse.json({ error: "run has no stored understanding" }, { status: 409 });
  }

  try {
    const { understanding: proved, outcome } = await proveReviewRun({
      reviewRunId: run.reviewRunId,
      repo: pr.repo,
      understanding,
    });
    return NextResponse.json({
      lines: understandingPatches(proved),
      outcome: {
        command: outcome.command,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 500) }, { status: 422 });
  }
}
