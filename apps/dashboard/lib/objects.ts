import { makeFsObjectStore } from "@cyclops/adapter-local-blob";
import { makeS3ObjectStore, s3ConfigFromEnv } from "@cyclops/adapter-s3-blob";
import type { ObjectStorePort } from "@cyclops/ports";

/**
 * S3 when the deployment is configured for it, the filesystem otherwise.
 *
 * The choice is made by presence, not by a flag, so local development needs no
 * new variable and behaves exactly as before. A half-set S3 configuration
 * throws instead of falling back: on Vercel the filesystem is discarded between
 * requests, so a silent fallback would look like it worked and lose every log.
 */
export const objectStore = (): ObjectStorePort => {
  const s3 = s3ConfigFromEnv(process.env);
  return s3
    ? makeS3ObjectStore(s3)
    : makeFsObjectStore(process.env.CYCLOPS_BLOB_DIR ?? ".data/dashboard-objects");
};

/** Run ids carry colons. Object keys do not, so they are flattened once, here. */
export const logKey = (runId: string, name: string): string =>
  `runs/${runId.replaceAll(":", "_")}/${name}`;
