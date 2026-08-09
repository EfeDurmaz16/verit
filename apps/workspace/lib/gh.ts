import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PRCheck, PRMeta } from "./schema";

const exec = promisify(execFile);

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  const short = url.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) return { repo: short[1], number: Number(short[2]) };
  return null;
}

interface RawCheck {
  __typename: string;
  name?: string;
  context?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

function normalizeCheck(c: RawCheck): PRCheck {
  const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase();
  const status =
    conclusion === "SUCCESS"
      ? "pass"
      : conclusion === "FAILURE" || conclusion === "ERROR"
        ? "fail"
        : c.status === "IN_PROGRESS" || c.status === "QUEUED" || conclusion === "PENDING"
          ? "running"
          : "skipped";
  return {
    name: c.name ?? c.context ?? "check",
    workflow: c.workflowName ?? "",
    status,
    url: c.detailsUrl ?? c.targetUrl,
  };
}

export async function fetchPR(repo: string, number: number): Promise<PRMeta> {
  const { stdout } = await exec(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      "title,number,author,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,commits,statusCheckRollup,body,createdAt,files,reviews,comments",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const d = JSON.parse(stdout);
  return {
    repo,
    number,
    headSha: d.headRefOid ?? "",
    url: `https://github.com/${repo}/pull/${number}`,
    title: d.title,
    author: d.author?.login ?? "unknown",
    branch: d.headRefName,
    base: d.baseRefName,
    body: d.body ?? "",
    additions: d.additions,
    deletions: d.deletions,
    changedFiles: d.changedFiles,
    commits: (d.commits ?? []).map(
      (c: { oid: string; messageHeadline: string; authors?: { login?: string; name?: string }[]; committedDate: string }) => ({
        sha: c.oid?.slice(0, 7) ?? "",
        message: c.messageHeadline,
        author: c.authors?.[0]?.login ?? c.authors?.[0]?.name ?? "",
        date: c.committedDate,
      }),
    ),
    reviews: (d.reviews ?? []).map(
      (r: { author?: { login?: string }; state: string; body: string; submittedAt: string }) => ({
        author: r.author?.login ?? "",
        state: r.state,
        body: r.body ?? "",
        date: r.submittedAt,
      }),
    ),
    comments: (d.comments ?? []).map(
      (c: { author?: { login?: string }; body: string; createdAt: string }) => ({
        author: c.author?.login ?? "",
        body: c.body ?? "",
        date: c.createdAt,
      }),
    ),
    checks: (d.statusCheckRollup ?? []).map(normalizeCheck),
    files: d.files ?? [],
  };
}
