import Link from "next/link";
import { Empty } from "@/components/bits";
import { allowed } from "@/lib/guard";
import { listAllRepos, type RepoRow } from "@/lib/runs";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const LOGIN_ERROR: Record<string, string> = {
  "not-configured": "GitHub login is not configured on this deployment.",
  "no-code": "GitHub did not send a code back. Try again.",
  "bad-state": "That login did not start here. Try again.",
  "no-token": "GitHub refused to issue a token.",
  "no-user": "GitHub issued a token but would not say who you are.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ login?: string }>;
}) {
  const session = await currentSession();
  const { login } = await searchParams;

  if (!session) {
    return (
      <div className="mx-auto max-w-[420px] pt-16 text-center">
        <h1 className="text-[15px] font-medium">Sign in to see your runs</h1>
        <p className="mt-1.5 text-[13px] text-ink-2">
          Verit shows the repos you can already read on GitHub, and nothing else.
        </p>
        {login && (
          <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-[12px] text-danger">
            {LOGIN_ERROR[login] ?? "Login failed. Try again."}
          </p>
        )}
        <a
          href="/api/auth/github"
          className="mt-5 inline-block rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium hover:border-accent hover:text-accent-text"
        >
          Sign in with GitHub
        </a>
      </div>
    );
  }

  // ponytail: one access check per connected repo, cached with a TTL. Fine for
  // the handful of repos phase 1 has. Group the check by org if that grows.
  const repos = await listAllRepos();
  const visible: RepoRow[] = [];
  for (const repo of repos) {
    if (await allowed(session, repo.id)) visible.push(repo);
  }
  const owners = [...new Set(visible.map((r) => r.owner))];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[15px] font-medium">Your organizations</h1>
      {owners.length === 0 ? (
        <Empty
          title="No connected repos yet"
          hint="Register a repo with pnpm --filter @verit/dashboard register-repo owner/name, then run the Action there."
        />
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {owners.map((owner) => (
            <li key={owner}>
              <Link
                href={`/o/${owner}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2"
              >
                <span className="font-mono text-[13px]">{owner}</span>
                <span className="tnum ml-auto text-[11px] text-ink-3">
                  {visible.filter((r) => r.owner === owner).length} repos
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
