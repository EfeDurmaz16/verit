import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFsObjectStore } from "@verit/adapter-local-blob";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runRetention } from "./retention";

/** A run row as the fake store holds it. */
interface Row {
  id: string;
  uploadedAt: Date;
  logKeys: string[];
}

const days = (n: number) => n * 24 * 60 * 60 * 1000;

/**
 * Seeds an old run and a fresh run, each with a real blob on disk, plus an
 * ancient run past the row window, runs the job, and asserts only the old data
 * is gone. The object store is the real filesystem adapter, so blob deletion is
 * proven against the store abstraction, not a mock.
 */
describe("runRetention", () => {
  it("deletes old logs and old rows, and leaves fresh data untouched", async () => {
    const now = new Date("2026-08-21T00:00:00Z");
    const store = makeFsObjectStore(await mkdtemp(join(tmpdir(), "verit-retention-")));

    const rows: Row[] = [
      { id: "run:old", uploadedAt: new Date(now.getTime() - days(40)), logKeys: ["runs/run_old/prove.log"] },
      { id: "run:fresh", uploadedAt: new Date(now.getTime() - days(1)), logKeys: ["runs/run_fresh/prove.log"] },
      { id: "run:ancient", uploadedAt: new Date(now.getTime() - days(400)), logKeys: ["runs/run_ancient/prove.log"] },
    ];
    for (const r of rows) {
      await Effect.runPromise(store.put(r.logKeys[0] as string, `log for ${r.id}\n`, "text/plain"));
    }

    const report = await runRetention({
      now,
      blobTtlDays: 30,
      rowTtlDays: 365,
      runsWithBlobsBefore: async (cutoff) =>
        rows.filter((r) => r.uploadedAt < cutoff && r.logKeys.length > 0),
      deleteObject: (key) => Effect.runPromise(store.delete(key)),
      clearBlobRefs: async (id) => {
        const r = rows.find((x) => x.id === id);
        if (r) r.logKeys = [];
      },
      deleteRunsBefore: async (cutoff) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if ((rows[i] as Row).uploadedAt < cutoff) rows.splice(i, 1);
        }
        return before - rows.length;
      },
    });

    // Fresh blob still on disk; old and ancient blobs gone.
    expect(await Effect.runPromise(store.get("runs/run_fresh/prove.log"))).not.toBeNull();
    expect(await Effect.runPromise(store.get("runs/run_old/prove.log"))).toBeNull();
    expect(await Effect.runPromise(store.get("runs/run_ancient/prove.log"))).toBeNull();

    // The old run keeps its (metadata) row with blob refs cleared; the ancient
    // run's row is deleted; the fresh run is wholly untouched.
    expect(rows.map((r) => r.id).sort()).toEqual(["run:fresh", "run:old"]);
    expect(rows.find((r) => r.id === "run:old")?.logKeys).toEqual([]);
    expect(rows.find((r) => r.id === "run:fresh")?.logKeys).toEqual(["runs/run_fresh/prove.log"]);

    expect(report).toEqual({ blobsDeleted: 2, runsBlobCleared: 2, rowsDeleted: 1 });
  });

  it("is idempotent: a second pass over the same clock deletes nothing new", async () => {
    const now = new Date("2026-08-21T00:00:00Z");
    const rows: Row[] = [
      { id: "run:fresh", uploadedAt: new Date(now.getTime() - days(1)), logKeys: ["runs/run_fresh/prove.log"] },
    ];
    const deps = {
      now,
      blobTtlDays: 30,
      rowTtlDays: 365,
      runsWithBlobsBefore: async (cutoff: Date) =>
        rows.filter((r) => r.uploadedAt < cutoff && r.logKeys.length > 0),
      deleteObject: async () => {},
      clearBlobRefs: async (id: string) => {
        const r = rows.find((x) => x.id === id);
        if (r) r.logKeys = [];
      },
      deleteRunsBefore: async (cutoff: Date) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if ((rows[i] as Row).uploadedAt < cutoff) rows.splice(i, 1);
        }
        return before - rows.length;
      },
    };
    expect(await runRetention(deps)).toEqual({ blobsDeleted: 0, runsBlobCleared: 0, rowsDeleted: 0 });
    expect(await runRetention(deps)).toEqual({ blobsDeleted: 0, runsBlobCleared: 0, rowsDeleted: 0 });
  });
});
