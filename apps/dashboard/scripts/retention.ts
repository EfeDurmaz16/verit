import { db } from "../lib/db";
import { retention } from "../lib/retention";

/**
 * The scheduled retention job. Deletes prove logs and blobs past 30 days and
 * run rows past 12 months, then reports what it removed. Run it on a schedule
 * (a GitHub Actions cron, a Vercel Cron hitting a wrapper, or `pnpm retention`).
 *
 *   DATABASE_URL="..." pnpm --filter @verit/dashboard retention
 */
const main = async (): Promise<void> => {
  const report = await retention();
  console.log(
    `retention: ${report.blobsDeleted} blobs deleted, ` +
      `${report.runsBlobCleared} runs blob-cleared, ${report.rowsDeleted} rows deleted`,
  );
  await db().end();
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
