import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { BlobPort } from "@cyclops/ports";
import { StoreError } from "@cyclops/ports";

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
