import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFsObjectStore } from "@verit/adapter-local-blob";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { purgeRepo } from "./repo-delete";

interface Row {
  id: string;
  repoId: string;
  logKeys: string[];
}

/**
 * Two repos, each with runs and real blobs on disk. Purging one erases its rows
 * and blobs against the real store abstraction; the other repo is untouched.
 */
describe("purgeRepo", () => {
  it("removes every run row and blob of the target repo, leaving others intact", async () => {
    const store = makeFsObjectStore(await mkdtemp(join(tmpdir(), "verit-repo-delete-")));
    const rows: Row[] = [
      { id: "run:a1", repoId: "acme/widgets", logKeys: ["runs/a1/prove.log", "runs/a1/build.log"] },
      { id: "run:a2", repoId: "acme/widgets", logKeys: ["runs/a2/prove.log"] },
      { id: "run:b1", repoId: "other/thing", logKeys: ["runs/b1/prove.log"] },
    ];
    for (const r of rows) {
      for (const k of r.logKeys) {
        await Effect.runPromise(store.put(k, `log for ${r.id}\n`, "text/plain"));
      }
    }

    const report = await purgeRepo("acme/widgets", {
      runLogKeys: async (repoId) => rows.filter((r) => r.repoId === repoId).map((r) => r.logKeys),
      deleteObject: (key) => Effect.runPromise(store.delete(key)),
      deleteRunRows: async (repoId) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if ((rows[i] as Row).repoId === repoId) rows.splice(i, 1);
        }
        return before - rows.length;
      },
    });

    expect(report).toEqual({ blobsDeleted: 3, runsDeleted: 2 });

    // Target repo's blobs are gone from the store.
    for (const key of ["runs/a1/prove.log", "runs/a1/build.log", "runs/a2/prove.log"]) {
      expect(await Effect.runPromise(store.get(key))).toBeNull();
    }
    // The other repo's row and blob survive.
    expect(rows.map((r) => r.id)).toEqual(["run:b1"]);
    expect(await Effect.runPromise(store.get("runs/b1/prove.log"))).not.toBeNull();
  });
});
