import { Effect } from "effect";
import type { ObjectStorePort } from "@verit/ports";
import { query } from "./db";
import { objectStore } from "./objects";

/**
 * Retention is enforced as a deletion, not a promise. Two windows, both counted
 * from when the run was received (`uploaded_at`, the custody clock):
 *
 *  - after 30 days, the stored logs are deleted from the object store and the
 *    run's blob references cleared, while the row's metadata survives;
 *  - after 12 months, the row itself is deleted.
 *
 * The blob pass runs first and covers every run past 30 days, so a row reaching
 * the 12-month cut has no blobs left to orphan. The job is idempotent: a second
 * run over the same clock finds nothing new to delete.
 */
export const BLOB_TTL_DAYS = 30;
export const ROW_TTL_DAYS = 365;

const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

export interface RetentionDeps {
  readonly now: Date;
  readonly blobTtlDays: number;
  readonly rowTtlDays: number;
  /** Runs received before the cutoff that still hold blob keys. */
  readonly runsWithBlobsBefore: (
    cutoff: Date,
  ) => Promise<ReadonlyArray<{ id: string; logKeys: readonly string[] }>>;
  /** Remove one object from the store. Idempotent per the port contract. */
  readonly deleteObject: (key: string) => Promise<void>;
  /** Clear a run's blob references and log tail once its blobs are gone. */
  readonly clearBlobRefs: (runId: string) => Promise<void>;
  /** Delete run rows received before the cutoff. Returns the count removed. */
  readonly deleteRunsBefore: (cutoff: Date) => Promise<number>;
}

export interface RetentionReport {
  readonly blobsDeleted: number;
  readonly runsBlobCleared: number;
  readonly rowsDeleted: number;
}

export const runRetention = async (deps: RetentionDeps): Promise<RetentionReport> => {
  const blobCutoff = daysAgo(deps.now, deps.blobTtlDays);
  const rowCutoff = daysAgo(deps.now, deps.rowTtlDays);

  let blobsDeleted = 0;
  let runsBlobCleared = 0;
  for (const run of await deps.runsWithBlobsBefore(blobCutoff)) {
    for (const key of run.logKeys) {
      await deps.deleteObject(key);
      blobsDeleted++;
    }
    // Only after the blobs are gone: a crash between the two leaves keys the
    // next pass will retry, never a row that claims blobs the store dropped.
    await deps.clearBlobRefs(run.id);
    runsBlobCleared++;
  }

  const rowsDeleted = await deps.deleteRunsBefore(rowCutoff);
  return { blobsDeleted, runsBlobCleared, rowsDeleted };
};

/** The wired job: real Postgres queries against the given object store. */
export const retention = (
  store: ObjectStorePort = objectStore(),
  now: Date = new Date(),
): Promise<RetentionReport> =>
  runRetention({
    now,
    blobTtlDays: Number(process.env.VERIT_BLOB_TTL_DAYS) || BLOB_TTL_DAYS,
    rowTtlDays: Number(process.env.VERIT_ROW_TTL_DAYS) || ROW_TTL_DAYS,
    runsWithBlobsBefore: async (cutoff) =>
      (
        await query<{ id: string; log_keys: string[] }>(
          `SELECT id, log_keys FROM runs
            WHERE uploaded_at < $1 AND cardinality(log_keys) > 0`,
          [cutoff],
        )
      ).map((r) => ({ id: r.id, logKeys: r.log_keys })),
    deleteObject: (key) => Effect.runPromise(store.delete(key)),
    clearBlobRefs: async (runId) => {
      await query(`UPDATE runs SET log_keys = '{}', log_tail = NULL WHERE id = $1`, [runId]);
    },
    deleteRunsBefore: async (cutoff) =>
      (await query<{ id: string }>(`DELETE FROM runs WHERE uploaded_at < $1 RETURNING id`, [cutoff]))
        .length,
  });
