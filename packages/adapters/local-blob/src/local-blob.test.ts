import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { makeFsObjectStore } from "./index";

const dir = async () => mkdtemp(join(tmpdir(), "verit-obj-"));

describe("fs object store", () => {
  it("round-trips a body and its content type", async () => {
    const store = makeFsObjectStore(await dir());
    await Effect.runPromise(store.put("runs/run_1/test.log", "hello\n", "text/plain"));
    const got = await Effect.runPromise(store.get("runs/run_1/test.log"));
    expect(new TextDecoder().decode(got?.body)).toBe("hello\n");
    expect(got?.contentType).toBe("text/plain");
  });

  it("returns null for a key that was never written", async () => {
    const store = makeFsObjectStore(await dir());
    expect(await Effect.runPromise(store.get("runs/run_1/missing.log"))).toBeNull();
  });

  it("deletes a body and its content type, and reads back null after", async () => {
    const store = makeFsObjectStore(await dir());
    await Effect.runPromise(store.put("runs/run_1/test.log", "hello\n", "text/plain"));
    await Effect.runPromise(store.delete("runs/run_1/test.log"));
    expect(await Effect.runPromise(store.get("runs/run_1/test.log"))).toBeNull();
  });

  it("deleting a key that was never written is a success, not an error", async () => {
    const store = makeFsObjectStore(await dir());
    const exit = await Effect.runPromiseExit(store.delete("runs/run_1/missing.log"));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("refuses a key that would escape the store", async () => {
    const root = await dir();
    const store = makeFsObjectStore(root);
    for (const key of ["../escape", "runs/../../escape", "/etc/passwd", "runs//x"]) {
      const put = await Effect.runPromiseExit(store.put(key, "x", "text/plain"));
      expect(Exit.isFailure(put)).toBe(true);
      const get = await Effect.runPromiseExit(store.get(key));
      expect(Exit.isFailure(get)).toBe(true);
    }
    await expect(readFile(join(root, "..", "escape"), "utf8")).rejects.toThrow();
  });
});
