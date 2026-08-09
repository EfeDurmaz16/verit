import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PRMeta } from "./schema";

const exec = promisify(execFile);
const MB = 1024 * 1024;

/* module-level diff cache for /api/diff (dev-server lifetime) */
const diffCache = new Map<string, string>();
export function cachedDiff(repo: string, number: number): string | undefined {
  return diffCache.get(`${repo}#${number}`);
}
export async function fetchDiff(repo: string, number: number): Promise<string> {
  const key = `${repo}#${number}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  let diff: string;
  try {
    const { stdout } = await exec("gh", ["pr", "diff", String(number), "-R", repo], {
      maxBuffer: 64 * MB,
    });
    diff = stdout;
  } catch {
    // GitHub refuses whole-PR diffs over 20k lines (HTTP 406). Rebuild it
    // from the per-file endpoint, which limits per file instead.
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${repo}/pulls/${number}/files`, "--paginate"],
      { maxBuffer: 256 * MB },
    );
    const files = JSON.parse(
      // --paginate concatenates arrays: "][ " between pages
      `[${stdout.replaceAll("][", "],[")}]`,
    ).flat() as { filename: string; patch?: string }[];
    diff = files
      .map((f) =>
        f.patch
          ? `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`
          : `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n@@ patch omitted by GitHub (binary or too large) @@\n`,
      )
      .join("");
  }
  diffCache.set(key, diff);
  return diff;
}

/* Write everything the lanes need onto disk so they never fetch. */
export async function prefetchPR(pr: PRMeta, cwd: string): Promise<void> {
  const diff = await fetchDiff(pr.repo, pr.number);
  const tasks: Promise<unknown>[] = [
    writeFile(path.join(cwd, "diff.patch"), diff),
    writeFile(
      path.join(cwd, "pr.json"),
      JSON.stringify(
        {
          title: pr.title,
          description: pr.body,
          author: pr.author,
          branch: pr.branch,
          base: pr.base,
          commits: pr.commits,
          reviews: pr.reviews,
        },
        null,
        1,
      ),
    ),
    writeFile(path.join(cwd, "ci.json"), JSON.stringify(pr.checks, null, 1)),
    exec("gh", [
      "api",
      `repos/${pr.repo}/pulls/${pr.number}/comments`,
      "--paginate",
    ], { maxBuffer: 16 * MB })
      .then(({ stdout }) => writeFile(path.join(cwd, "comments.json"), stdout))
      .catch(() => writeFile(path.join(cwd, "comments.json"), "[]")),
  ];

  const failing = pr.checks.find((c) => c.status === "fail" && c.url);
  const runId = failing?.url?.match(/\/runs\/(\d+)/)?.[1];
  if (runId) {
    tasks.push(
      exec("gh", ["run", "view", runId, "--log-failed", "-R", pr.repo], {
        maxBuffer: 64 * MB,
      })
        .then(({ stdout }) =>
          writeFile(path.join(cwd, "ci-fail.log"), stdout.slice(-30000)),
        )
        .catch(() => {}),
    );
  }
  await Promise.all(tasks);
}
