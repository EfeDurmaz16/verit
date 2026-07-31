#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  buildReviewContext,
  compileReviewPack,
  inferEmbeddingSimilarEdges,
  inferSameAuthorPathEdges,
  runReviewUnderstand,
  stubPatch,
  stubPost,
  stubProve,
  stubRisk,
} from "@cyclops/application";
import { ingestRepoPath } from "@cyclops/adapter-fs-ingest";
import { makeGithubVcs } from "@cyclops/adapter-github";
import { makeLocalBlob } from "@cyclops/adapter-local-blob";
import {
  makeHeuristicClassifier,
  makeMemoryDocumentStore,
  makeProofRender,
} from "@cyclops/adapter-memory";
import { makeGraphStore } from "@cyclops/adapter-neo4j";
import { makePiHarness } from "@cyclops/adapter-pi";
import { makeSqliteDocumentStore } from "@cyclops/adapter-sqlite";
import { makeTreeSitterParser } from "@cyclops/adapter-treesitter";
import type { ReviewPresets } from "@cyclops/domain";

const help = `cyclops <command>

Commands:
  ingest <path>              Index repo (files, symbols, wiki, chunks)
  ingest-pr owner/repo#n     Fetch PR + explicit edges
  understand --dry-run       Stub understand → SQLite + proof spec
  review --pr owner/repo#n   Classify → understand → proof spec
  compile-pack               Emit review skills.toml from presets
`;

const defaultPresets: ReviewPresets = {
  reviewer_identity: "normal",
  proof_frequency: "behavior_default",
  codebase_automation: "off",
  inline_comments: "high_conf_only",
  domain: "GENERAL",
};

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(help);
    return;
  }

  const docs =
    process.env.CYCLOPS_SQLITE_PATH != null
      ? makeSqliteDocumentStore(process.env.CYCLOPS_SQLITE_PATH)
      : makeMemoryDocumentStore();
  const graph = await makeGraphStore();
  const parser = makeTreeSitterParser();
  const blob = makeLocalBlob();

  if (cmd === "ingest") {
    const path = resolve(rest[0] ?? ".");
    const repoId = `repo:local/${path.split("/").pop() ?? "repo"}`;
    const result = await Effect.runPromise(ingestRepoPath(graph, parser, repoId, path, docs));
    console.log(JSON.stringify({ repoId, ...result }, null, 2));
    return;
  }

  if (cmd === "compile-pack") {
    const compiled = compileReviewPack(defaultPresets);
    console.log(compiled.skillsToml);
    console.error(`skill_pack_hash=${compiled.skillPackHash}`);
    return;
  }

  if (cmd === "understand") {
    const dry = rest.includes("--dry-run") || rest.includes("-n") || rest.length === 0;
    if (!dry) throw new Error("usage: cyclops understand --dry-run");
    const context = buildReviewContext({
      pages: [],
      query: "dry-run",
      edges: [],
      prs: [],
      domain: "GENERAL",
    });
    const result = await Effect.runPromise(
      runReviewUnderstand({
        docs,
        graph,
        harness: makePiHarness(),
        classifier: makeHeuristicClassifier(),
        render: makeProofRender(),
      })({
        repoId: "repo:local/dry-run",
        title: "dry-run understand",
        body: "local dogfood",
        paths: ["README.md"],
        diff: "+ // dry-run",
        context,
        presets: defaultPresets,
        nowIso: new Date().toISOString(),
      }),
    );
    let understanding = stubProve(result.understanding);
    understanding = stubRisk(understanding);
    const patch = stubPatch();
    const posted = stubPost(result.spec);
    const path = await Effect.runPromise(
      blob.writeLocal(
        `${result.runId.replaceAll(":", "_")}.spec.json`,
        posted.body,
      ),
    );
    console.log(
      JSON.stringify(
        {
          runId: result.runId,
          skillPackHash: result.skillPackHash,
          what: understanding.what,
          patch: patch.summary,
          specPath: path,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "ingest-pr") {
    const spec = rest[0] ?? "";
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(spec);
    if (!m) throw new Error("usage: cyclops ingest-pr owner/repo#123");
    const [, owner, repo, num] = m;
    const vcs = makeGithubVcs(process.env.GITHUB_TOKEN);
    const { pr, closingNumbers, changedPaths } = await Effect.runPromise(
      vcs.fetchPullRequest(owner!, repo!, Number(num)),
    );
    await Effect.runPromise(graph.upsertRepo({ id: pr.repoId, fullName: `${owner}/${repo}` }));
    await Effect.runPromise(graph.upsertPullRequest(pr));
    for (const n of closingNumbers) {
      const otherId = `pr:${owner}/${repo}#${n}`;
      await Effect.runPromise(
        graph.upsertPREdge({
          id: `edge:closes:${pr.id}:${otherId}`,
          fromPrId: pr.id,
          toPrId: otherId,
          kind: "closes",
          inferred: false,
        }),
      );
    }
    const others = await Effect.runPromise(graph.listPullRequests(pr.repoId));
    const withMeta = others
      .filter((p) => p.id !== pr.id)
      .map((p) => ({ ...p, changedPaths: [] as string[], updatedAt: new Date().toISOString() }));
    const inferredB = inferSameAuthorPathEdges(
      { ...pr, changedPaths, updatedAt: new Date().toISOString() },
      withMeta,
    );
    const inferredC = inferEmbeddingSimilarEdges(pr, others, 0.8);
    for (const e of [...inferredB, ...inferredC]) {
      await Effect.runPromise(graph.upsertPREdge(e));
    }
    console.log(
      JSON.stringify(
        {
          pr: pr.number,
          paths: changedPaths.length,
          explicitCloses: closingNumbers,
          inferred: inferredB.length + inferredC.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "review") {
    const prFlag = rest.find((a) => a.startsWith("--pr="))?.slice(5) ?? rest[1];
    if (!prFlag) throw new Error("usage: cyclops review --pr=owner/repo#n");
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(prFlag.replace(/^--pr=/, ""));
    if (!m) throw new Error("bad --pr");
    const [, owner, repo, num] = m;
    const vcs = makeGithubVcs(process.env.GITHUB_TOKEN);
    const { pr, changedPaths } = await Effect.runPromise(
      vcs.fetchPullRequest(owner!, repo!, Number(num)),
    );
    await Effect.runPromise(graph.upsertRepo({ id: pr.repoId, fullName: `${owner}/${repo}` }));
    await Effect.runPromise(graph.upsertPullRequest(pr));
    const pages = await Effect.runPromise(graph.listWikiPages(pr.repoId));
    const edges = await Effect.runPromise(graph.listPREdges(pr.id));
    const prs = await Effect.runPromise(graph.listPullRequests(pr.repoId));
    const context = buildReviewContext({
      pages,
      query: pr.title,
      edges,
      prs,
      domain: "GENERAL",
    });
    let diff = changedPaths.join("\n");
    try {
      diff = await readFile(resolve(".data/last-diff.patch"), "utf8");
    } catch {
      /* use path list as stand-in */
    }
    const result = await Effect.runPromise(
      runReviewUnderstand({
        docs,
        graph,
        harness: makePiHarness(),
        classifier: makeHeuristicClassifier(),
        render: makeProofRender(),
      })({
        repoId: pr.repoId,
        prId: pr.id,
        title: pr.title,
        body: pr.body ?? "",
        paths: changedPaths,
        diff,
        context,
        presets: defaultPresets,
        nowIso: new Date().toISOString(),
      }),
    );
    const path = await Effect.runPromise(
      blob.writeLocal(`${result.runId.replaceAll(":", "_")}.spec.json`, JSON.stringify(result.spec, null, 2)),
    );
    console.log(JSON.stringify({ runId: result.runId, skillPackHash: result.skillPackHash, specPath: path }, null, 2));
    return;
  }

  console.error(help);
  process.exitCode = 1;
};

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
