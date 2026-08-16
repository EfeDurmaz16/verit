import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import neo4j from "neo4j-driver";
import { makeGraphStore, neo4jConstraints } from "./index";

/**
 * The real server. `docker compose up -d neo4j` then:
 *
 *   VERIT_NEO4J_URI=bolt://localhost:7687 \
 *   VERIT_NEO4J_PASSWORD=verit-dev \
 *   pnpm --filter @verit/adapter-neo4j test
 *
 * Unset, this suite is skipped, so CI without a graph stays green. Ids carry a
 * per-run suffix instead of wiping the database, so a local dev graph survives.
 */
const uri = process.env.VERIT_NEO4J_URI;

describe.skipIf(!uri)("neo4j graph store against a live server", () => {
  const t = Date.now();
  const repoId = `repo:it/${t}`;

  it("applies the constraints", async () => {
    const driver = neo4j.driver(
      uri ?? "",
      neo4j.auth.basic(
        process.env.VERIT_NEO4J_USER ?? "neo4j",
        process.env.VERIT_NEO4J_PASSWORD ?? "verit-dev",
      ),
    );
    const session = driver.session();
    try {
      for (const stmt of neo4jConstraints.split(";").map((s) => s.trim()).filter(Boolean)) {
        await session.run(stmt);
      }
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it("round-trips every node and edge kind through real Cypher", async () => {
    const store = await makeGraphStore();
    const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

    await run(store.upsertRepo({ id: repoId, fullName: "it/widgets", defaultBranch: "main" }));
    await run(
      store.upsertFile({ id: `file:${t}:src/a.ts`, repoId, path: "src/a.ts", language: "ts" }),
    );
    await run(
      store.upsertSymbol({
        id: `sym:${t}:a`,
        fileId: `file:${t}:src/a.ts`,
        name: "a",
        kind: "function",
        startLine: 1,
        endLine: 4,
      }),
    );
    await run(
      store.upsertWikiPage({
        id: `wiki:${t}:overview`,
        repoId,
        path: "overview.md",
        title: "Overview",
        body: "The widgets service.",
      }),
    );

    const pr = (n: number) => ({
      id: `pr:${t}:${n}`,
      repoId,
      number: n,
      title: `PR ${n}`,
      body: n === 1 ? "adds a retry" : undefined,
      author: "efe",
      baseRef: "main",
      headRef: `feat/${n}`,
      url: `https://example.test/pr/${n}`,
    });
    await run(store.upsertPullRequest(pr(1)));
    await run(store.upsertPullRequest(pr(2)));
    await run(
      store.upsertPREdge({
        id: `edge:${t}:1-2`,
        fromPrId: `pr:${t}:1`,
        toPrId: `pr:${t}:2`,
        kind: "linked",
        inferred: true,
        confidence: 0.9,
      }),
    );
    await run(store.linkRunToPr(`run:${t}:1`, `pr:${t}:1`));

    const wiki = await run(store.listWikiPages(repoId));
    expect(wiki).toEqual([
      {
        id: `wiki:${t}:overview`,
        repoId,
        path: "overview.md",
        title: "Overview",
        body: "The widgets service.",
      },
    ]);

    const got = await run(store.getPullRequest(`pr:${t}:1`));
    expect(got).toEqual(pr(1));
    expect(await run(store.getPullRequest(`pr:${t}:missing`))).toBeNull();

    const prs = await run(store.listPullRequests(repoId));
    expect(prs.map((p) => p.number).sort()).toEqual([1, 2]);

    const edges = await run(store.listPREdges(`pr:${t}:1`));
    expect(edges).toEqual([
      {
        id: `edge:${t}:1-2`,
        fromPrId: `pr:${t}:1`,
        toPrId: `pr:${t}:2`,
        kind: "linked",
        inferred: true,
        confidence: 0.9,
      },
    ]);
  });

  it("upserting the same node twice leaves one node", async () => {
    const store = await makeGraphStore();
    const page = {
      id: `wiki:${t}:twice`,
      repoId: `${repoId}:twice`,
      path: "twice.md",
      title: "First",
      body: "v1",
    };
    await Effect.runPromise(store.upsertRepo({ id: `${repoId}:twice`, fullName: "it/twice" }));
    await Effect.runPromise(store.upsertWikiPage(page));
    await Effect.runPromise(store.upsertWikiPage({ ...page, title: "Second", body: "v2" }));
    const pages = await Effect.runPromise(store.listWikiPages(`${repoId}:twice`));
    expect(pages).toEqual([{ ...page, title: "Second", body: "v2" }]);
  });
});
