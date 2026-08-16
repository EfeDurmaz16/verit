import { hashToken, newIngestToken } from "../lib/crypto";
import { db, query } from "../lib/db";

/**
 * Connects one repo and prints its ingest token once. Only the hash is stored,
 * so a lost token is reissued by running this again, never recovered.
 *
 *   pnpm --filter @verit/dashboard register-repo owner/name
 */
const main = async (): Promise<void> => {
  const slug = process.argv[2];
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error("usage: register-repo owner/name");
  }
  const [owner, name] = slug.split("/") as [string, string];
  const token = newIngestToken();
  await query(
    `INSERT INTO repos (id, owner, name, ingest_token_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET ingest_token_hash = excluded.ingest_token_hash`,
    [slug, owner, name, hashToken(token)],
  );
  console.log(`repo ${slug} connected`);
  console.log(`VERIT_INGEST_TOKEN=${token}`);
  console.log("Store it as a repository secret now. It is not shown again.");
  await db().end();
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
