import Link from "next/link";
import { Duration, Empty, Verdict, When } from "@/components/bits";
import { requireRepoAccess } from "@/lib/guard";
import { listRuns } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default async function RepoPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const { repo: row } = await requireRepoAccess(owner, repo);
  const runs = await listRuns(row.id);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[12px] text-ink-3">
          <Link href={`/o/${owner}`} className="hover:text-ink">
            {owner}
          </Link>
        </p>
        <h1 className="font-mono text-[15px] font-medium">{row.id}</h1>
      </div>

      {runs.length === 0 ? (
        <Empty
          title="No runs yet"
          hint="Runs appear here once the Action uploads one. Set CYCLOPS_DASHBOARD_URL and CYCLOPS_INGEST_TOKEN in the workflow."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-3">
                <th className="px-3 py-2 font-medium">PR</th>
                <th className="px-3 py-2 font-medium">Commit</th>
                <th className="px-3 py-2 font-medium">Verdict</th>
                <th className="px-3 py-2 font-medium">Proof</th>
                <th className="px-3 py-2 font-medium">Took</th>
                <th className="px-3 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  {/* the whole table scrolls sideways on a narrow screen, which
                      reads better than a title wrapped into a tower of words */}
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link
                      href={`/r/${row.id}/runs/${encodeURIComponent(run.id)}`}
                      className="text-accent-text hover:underline"
                    >
                      {run.prNumber ? `#${run.prNumber}` : "run"}
                    </Link>
                    {run.prTitle && (
                      <span className="ml-2 inline-block max-w-[46vw] truncate align-bottom text-ink-2 sm:max-w-[420px]">
                        {run.prTitle}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-3">
                    {run.headSha ? run.headSha.slice(0, 7) : "-"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Verdict verdict={run.verdict} />
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-3">
                    {run.proofCommand ?? "-"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Duration ms={run.durationMs} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <When at={run.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
