import { Octokit } from "@octokit/rest";
import { Effect } from "effect";
import type { CheckAnnotation, CheckPort, VcsPort } from "@verit/ports";
import { StoreError } from "@verit/ports";

/** GitHub accepts at most 50 annotations per Check Runs write. */
const ANNOTATIONS_PER_CALL = 50;

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Our camelCase annotation to GitHub's snake_case output annotation. */
const toGithubAnnotation = (a: CheckAnnotation) => ({
  path: a.path,
  start_line: a.startLine,
  end_line: a.endLine,
  annotation_level: a.annotationLevel,
  message: a.message,
  ...(a.title ? { title: a.title } : {}),
});

/**
 * The id of an existing Check Run with this name at this commit, or null. A
 * re-run of the Action posts to the same commit, and creating a second run of
 * the same name would leave two Checks on the PR. Listing first and updating
 * the match keeps it one Check Run that a re-run overwrites. A failed list
 * (no permission, transient error) returns null so the caller falls back to
 * create rather than dropping the Check entirely.
 */
const existingCheckRunId = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
): Promise<number | null> => {
  try {
    const { data } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      check_name: name,
      per_page: 100,
    });
    const runs = data.check_runs ?? [];
    const match = runs.find((c) => c.name === name);
    return match ? match.id : null;
  } catch {
    return null;
  }
};

/**
 * Check Runs need a token with `checks: write`. In an Action that is the
 * job's own GITHUB_TOKEN. Without one this is a dry run: the body is returned
 * for the caller to print, and nothing is posted. No GitHub App in v1.
 *
 * Annotations ride along in the output. GitHub caps a write at 50, so the
 * first 50 go on the create (or the dedupe update) and any remainder follow as
 * further updates to the same run. The caller has already resolved and capped
 * them, so this only batches and maps them; it never invents or clamps a line.
 *
 * `options.fetch` is the transport seam: tests inject a fake fetch here and
 * assert the exact request GitHub would have received.
 */
export const makeGithubChecks = (
  token?: string,
  options?: { fetch?: typeof globalThis.fetch },
): CheckPort => ({
  postCheckRun: ({
    owner,
    repo,
    headSha,
    name,
    conclusion,
    title,
    summary,
    annotations = [],
    detailsUrl,
  }) =>
    token
      ? Effect.tryPromise({
          try: async () => {
            const octokit = new Octokit({
              auth: token,
              ...(options?.fetch ? { request: { fetch: options.fetch } } : {}),
            });
            const batches = chunk(annotations.map(toGithubAnnotation), ANNOTATIONS_PER_CALL);
            const firstBatch = batches[0] ?? [];
            const output = {
              title,
              summary,
              ...(firstBatch.length > 0 ? { annotations: firstBatch } : {}),
            };
            const completed_at = new Date().toISOString();
            const detail = detailsUrl ? { details_url: detailsUrl } : {};

            const existingId = await existingCheckRunId(octokit, owner, repo, headSha, name);
            const { data } = existingId != null
              ? await octokit.checks.update({
                  owner,
                  repo,
                  check_run_id: existingId,
                  name,
                  status: "completed",
                  conclusion,
                  completed_at,
                  ...detail,
                  output,
                })
              : await octokit.checks.create({
                  owner,
                  repo,
                  name,
                  head_sha: headSha,
                  status: "completed",
                  conclusion,
                  completed_at,
                  ...detail,
                  output,
                });

            // remaining annotation batches update the same run, 50 at a time
            for (const batch of batches.slice(1)) {
              await octokit.checks.update({
                owner,
                repo,
                check_run_id: data.id,
                output: { title, summary, annotations: batch },
              });
            }
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
