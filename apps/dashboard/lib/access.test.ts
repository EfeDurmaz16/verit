import { describe, expect, it } from "vitest";
import { isFresh, resolveAccess, type AccessRow } from "./access";

const at = (iso: string) => new Date(iso);

describe("access cache TTL", () => {
  it("trusts an answer inside the TTL", () => {
    expect(isFresh(at("2026-08-09T10:00:00Z"), at("2026-08-09T10:09:59Z"), 600)).toBe(true);
  });

  it("expires an answer exactly at the TTL", () => {
    expect(isFresh(at("2026-08-09T10:00:00Z"), at("2026-08-09T10:10:00Z"), 600)).toBe(false);
  });

  it("treats a backwards clock as stale, not as fresh forever", () => {
    expect(isFresh(at("2026-08-09T10:00:00Z"), at("2026-08-09T09:59:00Z"), 600)).toBe(false);
  });
});

const harness = (cached: AccessRow | null, now: Date, verifyAnswer = true) => {
  const calls = { verify: 0, writes: [] as Array<{ canRead: boolean; at: Date }> };
  const resolve = resolveAccess({
    readCache: async () => cached,
    writeCache: async (_login, _repo, canRead, when) => {
      calls.writes.push({ canRead, at: when });
    },
    verify: async () => {
      calls.verify += 1;
      return verifyAnswer;
    },
    now: () => now,
    ttlSeconds: 600,
  });
  return { calls, resolve };
};

describe("resolveAccess", () => {
  it("serves a fresh cached yes without calling GitHub", async () => {
    const { calls, resolve } = harness(
      { canRead: true, checkedAt: at("2026-08-09T10:00:00Z") },
      at("2026-08-09T10:05:00Z"),
    );
    expect(await resolve("efe", "acme/widgets")).toBe(true);
    expect(calls.verify).toBe(0);
    expect(calls.writes).toHaveLength(0);
  });

  it("serves a fresh cached no without calling GitHub", async () => {
    const { calls, resolve } = harness(
      { canRead: false, checkedAt: at("2026-08-09T10:00:00Z") },
      at("2026-08-09T10:05:00Z"),
    );
    expect(await resolve("efe", "acme/widgets")).toBe(false);
    expect(calls.verify).toBe(0);
  });

  it("re-checks a stale entry and writes the answer back", async () => {
    const now = at("2026-08-09T10:30:00Z");
    const { calls, resolve } = harness({ canRead: false, checkedAt: at("2026-08-09T10:00:00Z") }, now);
    expect(await resolve("efe", "acme/widgets")).toBe(true);
    expect(calls.verify).toBe(1);
    expect(calls.writes).toEqual([{ canRead: true, at: now }]);
  });

  it("checks GitHub when nothing is cached", async () => {
    const now = at("2026-08-09T10:30:00Z");
    const { calls, resolve } = harness(null, now, false);
    expect(await resolve("efe", "acme/widgets")).toBe(false);
    expect(calls.verify).toBe(1);
    expect(calls.writes).toEqual([{ canRead: false, at: now }]);
  });
});
