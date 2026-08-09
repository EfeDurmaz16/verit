import { db, migrate } from "../lib/db";

/** Applies the schema. Every statement is idempotent, so re-running is safe. */
const main = async (): Promise<void> => {
  await migrate();
  console.log("schema applied");
  await db().end();
};

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
