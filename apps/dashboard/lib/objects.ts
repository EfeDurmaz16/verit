import { makeFsObjectStore } from "@cyclops/adapter-local-blob";
import type { ObjectStorePort } from "@cyclops/ports";

/**
 * The dev store writes under .data. The hosted deployment swaps in an R2
 * adapter behind the same port.
 * ponytail: filesystem only for now. Add the R2 adapter when the bucket exists,
 * it implements ObjectStorePort and nothing else here changes.
 */
export const objectStore = (): ObjectStorePort =>
  makeFsObjectStore(process.env.CYCLOPS_BLOB_DIR ?? ".data/dashboard-objects");

/** Run ids carry colons. Object keys do not, so they are flattened once, here. */
export const logKey = (runId: string, name: string): string =>
  `runs/${runId.replaceAll(":", "_")}/${name}`;
