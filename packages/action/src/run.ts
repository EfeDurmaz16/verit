/**
 * GitHub Action entry. Same pipeline as local `pnpm cli dogfood`.
 * Env: PR_SPEC=owner/repo#n, GITHUB_TOKEN, optional CYCLOPS_SQLITE_PATH / CYCLOPS_PI_BIN
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const pr = process.env.PR_SPEC ?? process.env.GITHUB_REPOSITORY_PR ?? "solana-foundation/pay#415";

const run = (args: string[]) => {
  console.error(`+ pnpm ${args.join(" ")}`);
  const r = spawnSync("pnpm", args, { cwd: root, stdio: "inherit", env: process.env });
  if ((r.status ?? 1) !== 0) {
    process.exit(r.status ?? 1);
  }
};

// Mirror CI locally:
//   PR_SPEC=solana-foundation/pay#415 CYCLOPS_SQLITE_PATH=.data/cyclops.db \\
//     pnpm --filter @cyclops/action exec tsx src/run.ts
run(["exec", "tsx", "packages/cli/src/main.ts", "dogfood", pr]);
