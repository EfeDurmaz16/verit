import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Effect } from "effect";
import type { BlobPort, ObjectStorePort, StoredObject } from "@verit/ports";
import { assertSafeObjectKey, StoreError } from "@verit/ports";

export const makeLocalBlob = (dir = ".data/proofs"): BlobPort => ({
  writeLocal: (name, body) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dir, { recursive: true });
        const path = join(dir, name);
        await writeFile(path, body, "utf8");
        return path;
      },
      catch: (e) => new StoreError("local blob", e),
    }),
});

const pathFor = (root: string, key: string): string => {
  assertSafeObjectKey(key);
  const base = resolve(root);
  const path = resolve(base, key);
  if (path !== base && !path.startsWith(base + sep)) {
    throw new StoreError(`object key escapes the store: ${key}`);
  }
  return path;
};

/**
 * The dev object store: one file per key under `dir`, plus a sidecar holding
 * the content type. R2 replaces this in the hosted deployment and nothing above
 * the port changes.
 */
export const makeFsObjectStore = (dir = ".data/objects"): ObjectStorePort => ({
  put: (key, body, contentType) =>
    Effect.tryPromise({
      try: async () => {
        const path = pathFor(dir, key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body);
        await writeFile(`${path}.type`, contentType, "utf8");
      },
      catch: (e) => (e instanceof StoreError ? e : new StoreError("fs object put", e)),
    }),
  get: (key) =>
    Effect.tryPromise({
      try: async (): Promise<StoredObject | null> => {
        const path = pathFor(dir, key);
        let body: Buffer;
        try {
          body = await readFile(path);
        } catch {
          return null;
        }
        const contentType = await readFile(`${path}.type`, "utf8").catch(
          () => "application/octet-stream",
        );
        return { body: new Uint8Array(body), contentType };
      },
      catch: (e) => (e instanceof StoreError ? e : new StoreError("fs object get", e)),
    }),
  delete: (key) =>
    Effect.tryPromise({
      try: async () => {
        const path = pathFor(dir, key);
        // `force` makes a missing file a success, which is what an idempotent
        // delete wants: a retry after a half-finished purge must still converge.
        await rm(path, { force: true });
        await rm(`${path}.type`, { force: true });
      },
      catch: (e) => (e instanceof StoreError ? e : new StoreError("fs object delete", e)),
    }),
});
