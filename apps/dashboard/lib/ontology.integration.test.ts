import { decodeRunUpload, type RunUpload } from "@verit/domain";
import { Either } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { importOntologySqlite } from "./ontology";

/**
 * The ontology SQL against a real Postgres. Same gate as runs.integration:
 *
 *   VERIT_PG_TEST_URL=postgres://verit:verit-dev@localhost:5433/verit \
 *   pnpm --filter @verit/dashboard test
 *
 * Unset, this suite is skipped. The pure logic is covered in ontology.test.ts;
 * this only proves the upserts, the risk-closing update, and the snapshot load
 * survive a round trip through the database.
 */
const pgUrl = process.env.VERIT_PG_TEST_URL;
if (pgUrl) process.env.DATABASE_URL = pgUrl;

const { db, migrate, query } = await import("./db");
const { saveRun } = await import("./runs");
const { exportOntologySqlite } = await import("./ontology");
const { loadOntologySnapshot, markDecisionMerged, recordRunOntology } = await import(
  "./ontology-store"
);

const t = Date.now();
const repoSlug = `it/onto-${t}`;

const run = (id: string, over: Record<string, unknown> = {}): RunUpload => {
  const decoded = decodeRunUpload({
    repo: repoSlug,
    run: {
      id,
      repoId: `repo:${repoSlug}`,
      skillPackHash: "a".repeat(64),
      domain: "GENERAL",
      createdAt: "2026-08-20T10:00:00.000Z",
    },
    understanding: {
      what: "Add the webhook sender.ts.",
      why: "Deliveries need a sender.",
      how: "sender.ts posts the payload.",
      proof_refs: [],
      risks: [{ area: "delivery", note: "sender can drop events", source: "reviewer" }],
    },
    proofSpec: { root: "workspace", elements: { workspace: { type: "Workspace", props: {} } } },
    pr: { number: 1, title: "add sender", url: "https://x.test/1", author: "efe" },
    prove: {
      command: "pnpm test",
      source: "package.json",
      repo: repoSlug,
      exitCode: 0,
      durationMs: 1000,
      timedOut: false,
      logTail: "green",
      startedAt: "2026-08-20T10:00:01.000Z",
    },
    ...over,
  });
  if (Either.isLeft(decoded)) throw new Error("test upload fails the schema");
  return decoded.right;
};

describe.skipIf(!pgUrl)("ontology against a live postgres", () => {
  afterAll(async () => {
    if (pgUrl) await db().end();
  });

  it("records a decision, closes a risk from a later run, and round-trips through sqlite", async () => {
    await migrate();
    await query(
      `INSERT INTO repos (id, owner, name, ingest_token_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [repoSlug, "it", `onto-${t}`, "c".repeat(64)],
    );

    // PR1 declares a "delivery" risk.
    const pr1 = run(`run:${t}:1`);
    await saveRun(pr1, []);
    await recordRunOntology(pr1);
    await markDecisionMerged(repoSlug, 1, "2026-08-19T10:00:00.000Z");

    // PR2 references #1 and its proof fails, which confirms the open risk.
    const pr2 = run(`run:${t}:2`, {
      understanding: {
        what: "Follow-up to #1: harden sender.ts.",
        why: "The delivery risk from #1 needs a guard.",
        how: "sender.ts now checks the ack.",
        proof_refs: [],
        risks: [],
      },
      pr: { number: 2, title: "follow-up to #1", url: "https://x.test/2", author: "efe" },
      prove: {
        command: "pnpm test",
        source: "package.json",
        repo: repoSlug,
        exitCode: 1,
        durationMs: 1000,
        timedOut: false,
        logTail: "red",
        startedAt: "2026-08-20T10:00:01.000Z",
      },
    });
    await saveRun(pr2, []);
    await recordRunOntology(pr2);

    const snap = await loadOntologySnapshot(repoSlug);
    expect(snap.decisions.map((d) => d.prNumber).sort()).toEqual([1, 2]);
    const declared = snap.risks.find((r) => r.runId === `run:${t}:1`);
    expect(declared?.status).toBe("confirmed");
    expect(declared?.closedByRun).toBe(`run:${t}:2`);
    expect(snap.decisions.find((d) => d.prNumber === 1)?.mergedAt).toContain("2026-08-19");

    // A re-post of PR2 must not duplicate its decision or observation.
    await recordRunOntology(pr2);
    const again = await loadOntologySnapshot(repoSlug);
    expect(again.decisions).toHaveLength(2);
    expect(again.observations).toHaveLength(2);

    const back = importOntologySqlite(exportOntologySqlite(snap));
    expect(back).toEqual(snap);
  });
});
