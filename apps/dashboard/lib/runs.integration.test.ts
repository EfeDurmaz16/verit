import { afterAll, describe, expect, it } from "vitest";
import { decodeRunUpload, type RunUpload } from "@verit/domain";
import { Either } from "effect";

/**
 * The real database. `docker compose up -d postgres` then:
 *
 *   VERIT_PG_TEST_URL=postgres://verit:verit-dev@localhost:5433/verit \
 *   pnpm --filter @verit/dashboard test
 *
 * Unset, this suite is skipped. The gate is its own variable, never
 * DATABASE_URL itself: a shell that happens to carry the production URL must
 * not silently become the test target.
 */
const pgUrl = process.env.VERIT_PG_TEST_URL;
if (pgUrl) process.env.DATABASE_URL = pgUrl;

const { db, migrate, query } = await import("./db");
const { getRun, listRuns, repoBySlug, saveRun } = await import("./runs");

const t = Date.now();
const repoSlug = `it/widgets-${t}`;

const upload = (over: Record<string, unknown> = {}): RunUpload => {
  const decoded = decodeRunUpload({
    repo: repoSlug,
    run: {
      id: `run:it:${t}`,
      repoId: `repo:${repoSlug}`,
      skillPackHash: "a".repeat(64),
      domain: "GENERAL",
      createdAt: "2026-08-17T10:00:00.000Z",
    },
    understanding: {
      what: "Adds a retry to the webhook sender.",
      why: "Deliveries dropped when the receiver restarted.",
      how: "sender.ts retries three times with a delay.",
      proof_refs: [{ kind: "command", label: "unit tests", value: "pnpm test", status: "pass" }],
      risks: [{ area: "delivery", note: "retries can reorder events" }],
    },
    proofSpec: { root: "workspace", elements: { workspace: { type: "Workspace", props: {} } } },
    pr: {
      number: 7,
      title: "retry webhook sends",
      url: "https://example.test/pr/7",
      author: "efe",
      headSha: "b".repeat(40),
    },
    prove: {
      command: "pnpm test",
      source: "package.json",
      repo: repoSlug,
      exitCode: 0,
      durationMs: 1200,
      timedOut: false,
      logTail: "all green",
      startedAt: "2026-08-17T10:00:01.000Z",
    },
    ...over,
  });
  if (Either.isLeft(decoded)) throw new Error("test upload fails the schema");
  return decoded.right;
};

describe.skipIf(!pgUrl)("dashboard ingest against a live postgres", () => {
  afterAll(async () => {
    if (pgUrl) await db().end();
  });

  it("migrates, saves a run, and reads it back decoded", async () => {
    await migrate();
    await query(
      `INSERT INTO repos (id, owner, name, ingest_token_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [repoSlug, "it", `widgets-${t}`, "c".repeat(64)],
    );
    expect((await repoBySlug(repoSlug))?.owner).toBe("it");

    const u = upload();
    await saveRun(u, ["runs/it/prove.log"]);

    const detail = await getRun(repoSlug, u.run.id);
    expect(detail).not.toBeNull();
    expect(detail?.verdict).toBe("success");
    expect(detail?.proofStatus).toBe("pass");
    expect(detail?.prNumber).toBe(7);
    expect(detail?.logKeys).toEqual(["runs/it/prove.log"]);
    expect(detail?.understanding?.what).toBe("Adds a retry to the webhook sender.");
    expect(detail?.proofSpec.root).toBe("workspace");
  });

  it("re-posting the same run id overwrites the row instead of duplicating", async () => {
    const u = upload({ prove: undefined });
    await saveRun(u, []);

    const runs = await listRuns(repoSlug);
    expect(runs.filter((r) => r.id === u.run.id)).toHaveLength(1);
    const detail = await getRun(repoSlug, u.run.id);
    expect(detail?.verdict).toBe("neutral");
    expect(detail?.proofStatus).toBe("none");
  });
});
