import { db, query } from "../lib/db";

/**
 * Revokes a repo's ingest token. The repo stays connected and its history stays
 * readable, but no upload with the current token is accepted again. Distinct
 * from register-repo, which reissues a fresh token; run that to reconnect.
 *
 *   pnpm --filter @verit/dashboard revoke-repo owner/name
 */
const main = async (): Promise<void> => {
  const slug = process.argv[2];
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error("usage: revoke-repo owner/name");
  }
  const rows = await query<{ id: string }>(
    `UPDATE repos SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [slug],
  );
  if (rows.length === 0) {
    // Either the repo is unknown or it was revoked already. Both leave the
    // system in the intended state, so this is a note, not a failure.
    const known = await query<{ id: string }>(`SELECT id FROM repos WHERE id = $1`, [slug]);
    console.log(known.length ? `repo ${slug} was already revoked` : `no such repo ${slug}`);
  } else {
    console.log(`repo ${slug} ingest token revoked; uploads with it now 401`);
    console.log("Run register-repo to issue a fresh token and reconnect.");
  }
  await db().end();
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
