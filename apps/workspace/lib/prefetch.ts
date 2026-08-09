import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BLOCKS_FILE } from "./codex";
import { PROMPT_VERSION } from "./prompt";
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
    // GitHub refuses whole-PR diffs over 20k lines (HTTP 406) — rebuild it
    // from the per-file endpoint, which limits per file instead
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

/* ---- head-SHA cache: same PR + same commit → instant replay ---- */

interface CacheMeta {
  threadId: string | null;
}

function cacheDir(pr: PRMeta): string {
  const key = `${pr.repo.replace("/", "_")}-${pr.number}-${pr.headSha.slice(0, 12)}-${PROMPT_VERSION}`;
  return path.join(os.homedir(), ".cache", "lattice", key);
}

export async function readCache(
  pr: PRMeta,
): Promise<{ lines: string[]; threadId: string | null } | null> {
  const dir = cacheDir(pr);
  if (!pr.headSha || !existsSync(path.join(dir, BLOCKS_FILE))) return null;
  try {
    const [blocks, metaRaw] = await Promise.all([
      readFile(path.join(dir, BLOCKS_FILE), "utf8"),
      readFile(path.join(dir, "meta.json"), "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as CacheMeta;
    return {
      lines: blocks.split("\n").filter((l) => l.trim()),
      threadId: meta.threadId,
    };
  } catch {
    return null;
  }
}

export async function saveCache(
  pr: PRMeta,
  workdir: string,
  threadId: string | null,
): Promise<void> {
  if (!pr.headSha) return;
  const dir = cacheDir(pr);
  try {
    await mkdir(dir, { recursive: true });
    const parts = await Promise.all(
      ["lead", "insight", "structure"].map((l) =>
        readFile(path.join(workdir, `blocks-${l}.ndjson`), "utf8").catch(() => ""),
      ),
    );
    await writeFile(path.join(dir, BLOCKS_FILE), parts.join(""));
    await writeFile(path.join(dir, "meta.json"), JSON.stringify({ threadId } satisfies CacheMeta));
  } catch {
    /* cache is best-effort */
  }
}
