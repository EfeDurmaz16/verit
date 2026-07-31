/**
 * GitHub Action entry — delegates to CLI review for dogfood PRs.
 * Env: PR_SPEC=owner/repo#n, GITHUB_TOKEN, optional CYCLOPS_SQLITE_PATH
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pr = process.env.PR_SPEC ?? process.env.GITHUB_REPOSITORY_PR ?? "";
if (!pr) {
  console.error("Set PR_SPEC=owner/repo#number");
  process.exit(1);
}

const r = spawnSync(
  "pnpm",
  ["exec", "tsx", "packages/cli/src/main.ts", "review", `--pr=${pr}`],
  { cwd: root, stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);
