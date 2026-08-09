import Link from "next/link";
import { Empty, Verdict, When } from "@/components/bits";
import { allowed, requireSession } from "@/lib/guard";
import { listReposForOwner } from "@/lib/runs";

export const dynamic = "force-dynamic";

export default async function OrgPage({ params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  const session = await requireSession();
  const rows = await listReposForOwner(owner);

  const visible: Awaited<ReturnType<typeof listReposForOwner>> = [];
  for (const row of rows) {
    if (await allowed(session, row.repo.id)) visible.push(row);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-mono text-[15px] font-medium">{owner}</h1>
        <p className="text-[12px] text-ink-3">Connected repos and their last run.</p>
      </div>
      {visible.length === 0 ? (
        <Empty
          title="Nothing to show here"
          hint="Either this org has no connected repos, or you cannot read them on GitHub."
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {visible.map(({ repo, lastRun }) => (
            <li key={repo.id}>
              <Link
                href={`/r/${repo.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-surface-2"
              >
                <span className="font-mono text-[13px]">{repo.name}</span>
                {lastRun ? (
                  <>
                    <Verdict verdict={lastRun.verdict} />
                    <span className="ml-auto text-[11px]">
                      <When at={lastRun.createdAt} />
                    </span>
                  </>
                ) : (
                  <span className="ml-auto text-[11px] text-ink-3">no runs yet</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
