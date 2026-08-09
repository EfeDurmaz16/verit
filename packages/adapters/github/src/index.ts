import { Octokit } from "@octokit/rest";
import { Effect } from "effect";
import type { CheckPort, VcsPort } from "@cyclops/ports";
import { StoreError } from "@cyclops/ports";

/**
 * Check Runs need a token with `checks: write` — in an Action that is the
 * job's own GITHUB_TOKEN. Without one this is a dry run: the body is returned
 * for the caller to print, and nothing is posted. No GitHub App in v1.
 */
export const makeGithubChecks = (token?: string): CheckPort => ({
  postCheckRun: ({ owner, repo, headSha, name, conclusion, title, summary }) =>
    token
      ? Effect.tryPromise({
          try: async () => {
            const { data } = await new Octokit({ auth: token }).checks.create({
              owner,
              repo,
              name,
              head_sha: headSha,
              status: "completed",
              conclusion,
              completed_at: new Date().toISOString(),
              output: { title, summary },
            });
            return { posted: true, url: data.html_url };
          },
          catch: (e) => new StoreError("github create check run", e),
        })
      : Effect.succeed({ posted: false, url: null }),
});

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
          const patchParts: string[] = [];
          for (const f of files) {
            if (f.patch) {
              patchParts.push(`diff --git a/${f.filename} b/${f.filename}\n${f.patch}`);
            } else {
              patchParts.push(`# ${f.status ?? "changed"}: ${f.filename}`);
            }
          }
          const patch = patchParts.join("\n\n");
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
            patch,
          };
        },
        catch: (e) => new StoreError("github fetch PR", e),
      }),
  };
};
