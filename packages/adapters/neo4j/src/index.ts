import neo4j, { type Driver } from "neo4j-driver";
import { Effect } from "effect";
import type { GraphStore } from "@verit/ports";
import { StoreError } from "@verit/ports";
import { makeMemoryGraphStore } from "@verit/adapter-memory";

export const neo4jConstraints = `
CREATE CONSTRAINT repo_id IF NOT EXISTS FOR (r:Repo) REQUIRE r.id IS UNIQUE;
CREATE CONSTRAINT file_id IF NOT EXISTS FOR (f:File) REQUIRE f.id IS UNIQUE;
CREATE CONSTRAINT symbol_id IF NOT EXISTS FOR (s:Symbol) REQUIRE s.id IS UNIQUE;
CREATE CONSTRAINT wiki_id IF NOT EXISTS FOR (w:WikiPage) REQUIRE w.id IS UNIQUE;
CREATE CONSTRAINT pr_id IF NOT EXISTS FOR (p:PullRequest) REQUIRE p.id IS UNIQUE;
CREATE CONSTRAINT edge_id IF NOT EXISTS FOR (e:PREdge) REQUIRE e.id IS UNIQUE;
`;

/** Prefer live Neo4j when VERIT_NEO4J_URI is set; otherwise memory graph (tests/dogfood without Docker). */
export const makeGraphStore = async (): Promise<GraphStore> => {
  const uri = process.env.VERIT_NEO4J_URI;
  if (!uri) return makeMemoryGraphStore();
  const user = process.env.VERIT_NEO4J_USER ?? "neo4j";
  const password = process.env.VERIT_NEO4J_PASSWORD ?? "verit-dev";
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    await driver.verifyConnectivity();
  } catch (e) {
    await driver.close();
    throw new StoreError("neo4j connectivity failed", e);
  }
  return makeNeo4jGraphStore(driver);
};

export const makeNeo4jGraphStore = (driver: Driver): GraphStore => {
  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  };

  const wrap = <A>(fn: () => Promise<A>) =>
    Effect.tryPromise({
      try: fn,
      catch: (e) => new StoreError("neo4j", e),
    });

  return {
    upsertRepo: (r) =>
      wrap(async () => {
        await run(
          `MERGE (r:Repo {id: $id}) SET r.fullName = $fullName, r.defaultBranch = $defaultBranch`,
          { id: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch ?? null },
        );
      }),
    upsertFile: (f) =>
      wrap(async () => {
        await run(
          `MERGE (f:File {id: $id}) SET f.path = $path, f.language = $language, f.repoId = $repoId
           WITH f MATCH (r:Repo {id: $repoId}) MERGE (r)-[:HAS_FILE]->(f)`,
          { id: f.id, path: f.path, language: f.language ?? null, repoId: f.repoId },
        );
      }),
    upsertSymbol: (s) =>
      wrap(async () => {
        await run(
          `MERGE (s:Symbol {id: $id}) SET s.name = $name, s.kind = $kind, s.startLine = $startLine, s.endLine = $endLine, s.fileId = $fileId
           WITH s MATCH (f:File {id: $fileId}) MERGE (f)-[:DECLARES]->(s)`,
          {
            id: s.id,
            name: s.name,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            fileId: s.fileId,
          },
        );
      }),
    upsertWikiPage: (w) =>
      wrap(async () => {
        await run(
          `MERGE (w:WikiPage {id: $id}) SET w.path = $path, w.title = $title, w.body = $body, w.repoId = $repoId
           WITH w MATCH (r:Repo {id: $repoId}) MERGE (r)-[:HAS_WIKI]->(w)`,
          { id: w.id, path: w.path, title: w.title, body: w.body, repoId: w.repoId },
        );
      }),
    upsertPullRequest: (p) =>
      wrap(async () => {
        await run(
          `MERGE (p:PullRequest {id: $id}) SET p += $props
           WITH p MATCH (r:Repo {id: $repoId}) MERGE (r)-[:HAS_PR]->(p)`,
          {
            id: p.id,
            repoId: p.repoId,
            props: {
              number: p.number,
              title: p.title,
              body: p.body ?? null,
              author: p.author,
              baseRef: p.baseRef,
              headRef: p.headRef,
              url: p.url,
              repoId: p.repoId,
            },
          },
        );
      }),
    upsertPREdge: (e) =>
      wrap(async () => {
        await run(
          `MERGE (e:PREdge {id: $id}) SET e.kind = $kind, e.inferred = $inferred, e.confidence = $confidence,
             e.fromPrId = $fromPrId, e.toPrId = $toPrId
           WITH e
           MATCH (a:PullRequest {id: $fromPrId}), (b:PullRequest {id: $toPrId})
           MERGE (a)-[:PR_LINK {kind: $kind, inferred: $inferred}]->(b)`,
          {
            id: e.id,
            kind: e.kind,
            inferred: e.inferred,
            confidence: e.confidence ?? null,
            fromPrId: e.fromPrId,
            toPrId: e.toPrId,
          },
        );
      }),
    listWikiPages: (repoId) =>
      wrap(async () => {
        const res = await run(
          `MATCH (w:WikiPage {repoId: $repoId}) RETURN w`,
          { repoId },
        );
        return res.records.map((rec) => {
          const w = rec.get("w").properties;
          return {
            id: String(w.id),
            repoId: String(w.repoId),
            path: String(w.path),
            title: String(w.title),
            body: String(w.body),
          };
        });
      }),
    listPREdges: (prId) =>
      wrap(async () => {
        const res = await run(
          `MATCH (e:PREdge) WHERE e.fromPrId = $prId OR e.toPrId = $prId RETURN e`,
          { prId },
        );
        return res.records.map((rec) => {
          const e = rec.get("e").properties;
          return {
            id: String(e.id),
            fromPrId: String(e.fromPrId),
            toPrId: String(e.toPrId),
            kind: e.kind,
            inferred: Boolean(e.inferred),
            confidence: e.confidence != null ? Number(e.confidence) : undefined,
          };
        });
      }),
    getPullRequest: (id) =>
      wrap(async () => {
        const res = await run(`MATCH (p:PullRequest {id: $id}) RETURN p`, { id });
        const rec = res.records[0];
        if (!rec) return null;
        const p = rec.get("p").properties;
        return {
          id: String(p.id),
          repoId: String(p.repoId),
          number: Number(p.number),
          title: String(p.title),
          body: p.body ? String(p.body) : undefined,
          author: String(p.author),
          baseRef: String(p.baseRef),
          headRef: String(p.headRef),
          url: String(p.url),
        };
      }),
    listPullRequests: (repoId) =>
      wrap(async () => {
        const res = await run(`MATCH (p:PullRequest {repoId: $repoId}) RETURN p`, { repoId });
        return res.records.map((rec) => {
          const p = rec.get("p").properties;
          return {
            id: String(p.id),
            repoId: String(p.repoId),
            number: Number(p.number),
            title: String(p.title),
            body: p.body ? String(p.body) : undefined,
            author: String(p.author),
            baseRef: String(p.baseRef),
            headRef: String(p.headRef),
            url: String(p.url),
          };
        });
      }),
    linkRunToPr: (runId, prId) =>
      wrap(async () => {
        await run(
          `MERGE (run:ReviewRun {id: $runId}) WITH run MATCH (p:PullRequest {id: $prId}) MERGE (run)-[:FOR_PR]->(p)`,
          { runId, prId },
        );
      }),
  };
};
