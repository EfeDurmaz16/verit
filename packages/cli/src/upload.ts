import { encodeRunUpload, type RunUpload } from "@verit/domain";
import { proveLogBody } from "@verit/application";
import { Either } from "effect";
import type { ProveOutcome } from "@verit/ports";

/**
 * Where a run's proof page lives. The Check Run links here, so the shape is
 * fixed: /r/{owner}/{repo}/runs/{runId}. Run ids carry colons, which are legal
 * in a path segment but read badly, so the id is encoded once.
 */
export const proofPageUrl = (base: string, repo: string, runId: string): string =>
  `${base.replace(/\/+$/, "")}/r/${repo}/runs/${encodeURIComponent(runId)}`;

export interface DashboardTarget {
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * Both variables or nothing. An unset VERIT_DASHBOARD_URL means the run is
 * never uploaded and CI behaves exactly as it did before, which is the whole
 * point of gating this on env.
 */
export const dashboardTarget = (env: NodeJS.ProcessEnv = process.env): DashboardTarget | null => {
  const baseUrl = env.VERIT_DASHBOARD_URL?.trim();
  const token = env.VERIT_INGEST_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
};

export const buildUpload = (input: {
  repo: string;
  run: RunUpload["run"];
  understanding: RunUpload["understanding"];
  proofSpec: unknown;
  pr?: RunUpload["pr"];
  outcome: ProveOutcome | null;
}): RunUpload => {
  const spec = input.proofSpec as { root?: unknown; elements?: unknown };
  return {
    repo: input.repo,
    run: input.run,
    understanding: input.understanding,
    proofSpec: {
      root: typeof spec.root === "string" ? spec.root : "",
      elements: (spec.elements ?? {}) as Record<string, unknown>,
    },
    pr: input.pr,
    prove: input.outcome
      ? {
          command: input.outcome.command,
          source: input.outcome.source,
          repo: input.outcome.repo,
          exitCode: input.outcome.exitCode,
          durationMs: input.outcome.durationMs,
          timedOut: input.outcome.timedOut,
          logTail: input.outcome.logTail,
          startedAt: input.outcome.startedAt,
        }
      : undefined,
    logs: input.outcome ? [
      { name: "prove.log", contentType: "text/plain", body: proveLogBody(input.outcome) },
    ] : undefined,
  };
};

/**
 * Posts one finished run. Never throws: a dashboard that is down, slow or
 * misconfigured must not fail a review that already ran and already posted its
 * Check. The failure is reported on stderr and the job continues.
 */
export const uploadRun = async (
  target: DashboardTarget,
  upload: RunUpload,
): Promise<{ uploaded: boolean; error?: string }> => {
  const encoded = encodeRunUpload(upload);
  if (Either.isLeft(encoded)) {
    return { uploaded: false, error: `run does not match the upload schema: ${encoded.left.message}` };
  }
  try {
    const res = await fetch(`${target.baseUrl.replace(/\/+$/, "")}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.token}`,
        "X-Verit-Repo": upload.repo,
      },
      body: JSON.stringify(encoded.right),
    });
    if (!res.ok) {
      return { uploaded: false, error: `dashboard replied ${res.status}: ${await res.text()}` };
    }
    return { uploaded: true };
  } catch (e) {
    return { uploaded: false, error: e instanceof Error ? e.message : String(e) };
  }
};
