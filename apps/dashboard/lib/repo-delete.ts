import { Effect } from "effect";
import type { ObjectStorePort } from "@verit/ports";
import { query } from "./db";

/**
 * Erases one repo's run data: every stored blob and every run row. Blobs go
 * first, so a crash mid-way leaves rows the next call retries, never a row
 * pointing at a blob the store already dropped. The repo registration itself
 * stays, so a connected repo can keep ingesting after its history is cleared.
 */
export interface RepoDeleteDeps {
  /** The blob keys held by each of the repo's runs. */
  readonly runLogKeys: (repoId: string) => Promise<ReadonlyArray<readonly string[]>>;
  readonly deleteObject: (key: string) => Promise<void>;
  /** Delete the repo's run rows. Returns the count removed. */
  readonly deleteRunRows: (repoId: string) => Promise<number>;
}

export interface RepoDeleteReport {
  readonly blobsDeleted: number;
  readonly runsDeleted: number;
}

export const purgeRepo = async (
  repoId: string,
  deps: RepoDeleteDeps,
): Promise<RepoDeleteReport> => {
  let blobsDeleted = 0;
  for (const keys of await deps.runLogKeys(repoId)) {
    for (const key of keys) {
      await deps.deleteObject(key);
      blobsDeleted++;
    }
  }
  const runsDeleted = await deps.deleteRunRows(repoId);
  return { blobsDeleted, runsDeleted };
};

/** The wired erasure: real Postgres rows against the given object store. */
export const deleteRepoData = (
  repoId: string,
  store: ObjectStorePort,
): Promise<RepoDeleteReport> =>
  purgeRepo(repoId, {
    runLogKeys: async (id) =>
      (await query<{ log_keys: string[] }>(`SELECT log_keys FROM runs WHERE repo_id = $1`, [id])).map(
        (r) => r.log_keys,
      ),
    deleteObject: (key) => Effect.runPromise(store.delete(key)),
    deleteRunRows: async (id) =>
      (await query<{ id: string }>(`DELETE FROM runs WHERE repo_id = $1 RETURNING id`, [id])).length,
  });
