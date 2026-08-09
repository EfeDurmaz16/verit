import type { Spec } from "@json-render/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Duration, Verdict, When } from "@/components/bits";
import { ProofPage } from "@/components/proof-page";
import { requireRepoAccess } from "@/lib/guard";
import { getRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; runId: string }>;
}) {
  const { owner, repo, runId } = await params;
  const { repo: row } = await requireRepoAccess(owner, repo);
  const run = await getRun(row.id, decodeURIComponent(runId));
  if (!run) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[12px] text-ink-3">
          <Link href={`/o/${owner}`} className="hover:text-ink">
            {owner}
          </Link>
          {" / "}
          <Link href={`/r/${row.id}`} className="hover:text-ink">
            {row.name}
          </Link>
        </p>
        <h1 className="mt-0.5 text-[15px] font-medium">
          {run.prTitle ?? "Review run"}
          {run.prNumber ? <span className="ml-2 text-ink-3">#{run.prNumber}</span> : null}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-3">
          <Verdict verdict={run.verdict} />
          {run.proofCommand && (
            <span className="font-mono text-ink-2">{run.proofCommand}</span>
          )}
          {run.exitCode !== null && (
            <span>
              exit <span className="tnum text-ink-2">{run.exitCode}</span>
              {run.timedOut ? " (timed out)" : ""}
            </span>
          )}
          <Duration ms={run.durationMs} />
          <When at={run.createdAt} />
          {run.headSha && <span className="font-mono">{run.headSha.slice(0, 7)}</span>}
          {run.prUrl && (
            <a href={run.prUrl} className="text-accent-text hover:underline" rel="noreferrer">
              open on GitHub
            </a>
          )}
        </div>
      </div>

      <ProofPage spec={run.proofSpec as Spec} />

      {run.logKeys.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
            Full logs
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {run.logKeys.map((key) => {
              const name = key.split("/").pop() ?? key;
              return (
                <li key={key} className="px-3 py-2">
                  <a
                    href={`/r/${row.id}/runs/${encodeURIComponent(run.id)}/logs/${encodeURIComponent(name)}`}
                    className="font-mono text-[12px] text-accent-text hover:underline"
                  >
                    {name}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
