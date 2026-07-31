import { Octokit } from "@octokit/rest";
import { Effect } from "effect";
import type { VcsPort } from "@cyclops/ports";
import { StoreError } from "@cyclops/ports";

export const makeGithubVcs = (token?: string): VcsPort => {
  const octokit = new Octokit(token ? { auth: token } : {});
  return {
    fetchPullRequest: (owner, repo, number) =>
      Effect.tryPromise({
        try: async () => {
          const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
          const files = await octokit.paginate(octokit.pulls.listFiles, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          });
          const closingNumbers: number[] = [];
          const body = pr.body ?? "";
          for (const m of body.matchAll(/(?:closes|fixes|resolves)\s+#(\d+)/gi)) {
            closingNumbers.push(Number(m[1]));
          }
          return {
            pr: {
              id: `pr:${owner}/${repo}#${number}`,
              repoId: `repo:${owner}/${repo}`,
              number: pr.number,
              title: pr.title,
              body: pr.body ?? undefined,
              author: pr.user?.login ?? "unknown",
              baseRef: pr.base.ref,
              headRef: pr.head.ref,
              url: pr.html_url,
            },
            closingNumbers,
            changedPaths: files.map((f) => f.filename),
          };
        },
        catch: (e) => new StoreError("github fetch PR", e),
      }),
  };
};
