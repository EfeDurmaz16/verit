#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  ingest-pr owner/repo#n     Fetch PR + explicit/inferred edges
  understand --dry-run       Stub/Pi understand → DocumentStore + proof Spec
  review --pr owner/repo#n   Classify → understand → proof Spec (.data/proofs)
  compile-pack               Emit review skills.toml from presets
  dogfood owner/repo#n       ingest-pr → compile-pack → review (Action mirror)

Env:
  GITHUB_TOKEN          optional for public PRs; recommended for rate limits
  CYCLOPS_SQLITE_PATH   default .data/cyclops.db (set empty to use memory)
  CYCLOPS_PI_BIN        optional Pi binary; else deterministic stub Understanding
  CYCLOPS_PI_ARGS       optional args (default: understand --json)
  CYCLOPS_NEO4J_URI     optional bolt://… (memory graph fallback if unset)
`;

const defaultPresets: ReviewPresets = {
  reviewer_identity: "normal",
  proof_frequency: "behavior_default",
  codebase_automation: "off",
  inline_comments: "high_conf_only",
  domain: "GENERAL",
};

const makeDocs = () => {
  const path = process.env.CYCLOPS_SQLITE_PATH;
  if (path === "") return makeMemoryDocumentStore();
  return makeSqliteDocumentStore(path ?? ".data/cyclops.db");
};

const parsePrSpec = (spec: string): { owner: string; repo: string; number: number } => {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(spec);
  if (!m) throw new Error("usage: owner/repo#123");
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
};

const writeProofArtifacts = async (
  blob: ReturnType<typeof makeLocalBlob>,
  runId: string,
  spec: unknown,
  alias?: string,
) => {
  const body = JSON.stringify(spec, null, 2);
  const posted = stubPost(spec);
  const path = await Effect.runPromise(
    blob.writeLocal(`${runId.replaceAll(":", "_")}.spec.json`, posted.body),
  );
  await Effect.runPromise(blob.writeLocal("latest.spec.json", body));
  if (alias) {
    await Effect.runPromise(blob.writeLocal(alias, body));
  }
  return path;
};

const runUnderstandPipeline = async (input: {
  repoId: string;
  prId?: string;
  title: string;
  body: string;
  paths: readonly string[];
  diff: string;
  context: ReturnType<typeof buildReviewContext>;
  alias?: string;
}) => {
  const docs = makeDocs();
  const graph = await makeGraphStore();
  const result = await Effect.runPromise(
    runReviewUnderstand({
      docs,
      graph,
      harness: makePiHarness(),
      classifier: makeHeuristicClassifier(),
      render: makeProofRender(),
    })({
      repoId: input.repoId,
      prId: input.prId,
      title: input.title,
      body: input.body,
      paths: input.paths,
      diff: input.diff,
      context: input.context,
      presets: defaultPresets,
      nowIso: new Date().toISOString(),
    }),
  );
  let understanding = stubProve(result.understanding);
  understanding = stubRisk(understanding);
  const patch = stubPatch();
  // Re-render with prove/risk stubs so Spec matches enriched Understanding
  const render = makeProofRender();
  const enrichedSpec = render.toSpec({
    understanding,
    context: {
      ...input.context,
      domain: understanding.what ? input.context.domain : input.context.domain,
    },
    risksReviewer: understanding.risks.filter((r) => r.source === "reviewer"),
    archNodes: input.paths.slice(0, 24).map((p) => ({
      id: p,
      label: p.split("/").pop() ?? p,
    })),
    archEdges:
      input.paths.length > 1
        ? input.paths.slice(1, 24).map((p) => ({
            from: input.paths[0]!,
            to: p,
            kind: "co-changed",
          }))
        : [],
    suggestedPatch: patch.diff || undefined,
  });
  await Effect.runPromise(docs.saveUnderstandingJson(result.runId, understanding));
  const blob = makeLocalBlob();
  const specPath = await writeProofArtifacts(blob, result.runId, enrichedSpec, input.alias);
  return {
    runId: result.runId,
    skillPackHash: result.skillPackHash,
    what: understanding.what,
    risks: understanding.risks.length,
    proofRefs: understanding.proof_refs.length,
    patch: patch.summary,
    specPath,
  };
};

const ingestPr = async (spec: string) => {
  const { owner, repo, number } = parsePrSpec(spec);
  const graph = await makeGraphStore();
  const vcs = makeGithubVcs(process.env.GITHUB_TOKEN);
  const { pr, closingNumbers, changedPaths, patch } = await Effect.runPromise(
    vcs.fetchPullRequest(owner, repo, number),
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
  // Persist patch for review step
  await mkdir(resolve(".data"), { recursive: true });
  await writeFile(resolve(".data/last-diff.patch"), patch, "utf8");
  await writeFile(
    resolve(".data/last-pr.json"),
    JSON.stringify({ pr, changedPaths, closingNumbers }, null, 2),
    "utf8",
  );
  return { pr, changedPaths, closingNumbers, inferred: inferredB.length + inferredC.length, patch };
};

const reviewPr = async (spec: string) => {
  const { owner, repo, number } = parsePrSpec(spec);
  const graph = await makeGraphStore();
  const vcs = makeGithubVcs(process.env.GITHUB_TOKEN);
  const { pr, changedPaths, patch } = await Effect.runPromise(
    vcs.fetchPullRequest(owner, repo, number),
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
  let diff = patch;
  try {
    const cached = await readFile(resolve(".data/last-diff.patch"), "utf8");
    if (cached.length > diff.length) diff = cached;
  } catch {
    /* use API patch */
  }
  const alias = `${owner}-${repo}-${number}.spec.json`.replaceAll("/", "-");
  return runUnderstandPipeline({
    repoId: pr.repoId,
    prId: pr.id,
    title: pr.title,
    body: pr.body ?? "",
    paths: changedPaths,
    diff,
    context,
    alias,
  });
};

const main = async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(help);
    return;
  }

  const docs = makeDocs();
  const graph = await makeGraphStore();
  const parser = makeTreeSitterParser();

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
    const out = await runUnderstandPipeline({
      repoId: "repo:local/dry-run",
      title: "dry-run understand",
      body: "Local dogfood dry-run. No live PR attached.",
      paths: ["README.md", "packages/cli/src/main.ts"],
      diff: "+ // dry-run understand\n",
      context,
      alias: "dry-run.spec.json",
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === "ingest-pr") {
    const spec = rest[0] ?? "";
    const result = await ingestPr(spec);
    console.log(
      JSON.stringify(
        {
          pr: result.pr.number,
          title: result.pr.title,
          paths: result.changedPaths.length,
          explicitCloses: result.closingNumbers,
          inferred: result.inferred,
          patchChars: result.patch.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "review") {
    const prFlag =
      rest.find((a) => a.startsWith("--pr="))?.slice(5) ??
      (rest[0] === "--pr" ? rest[1] : rest[0]);
    if (!prFlag) throw new Error("usage: cyclops review --pr=owner/repo#n");
    const out = await reviewPr(prFlag.replace(/^--pr=/, ""));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === "dogfood") {
    const spec = rest[0] ?? process.env.PR_SPEC ?? "solana-foundation/pay#415";
    console.error(`dogfood: ingest-pr ${spec}`);
    const ingested = await ingestPr(spec);
    console.error(`dogfood: compile-pack`);
    const compiled = compileReviewPack(defaultPresets);
    console.error(`skill_pack_hash=${compiled.skillPackHash}`);
    console.error(`dogfood: review ${spec}`);
    const out = await reviewPr(spec);
    console.log(
      JSON.stringify(
        {
          ...out,
          ingested: {
            paths: ingested.changedPaths.length,
            patchChars: ingested.patch.length,
            title: ingested.pr.title,
          },
          skillPackHashCompile: compiled.skillPackHash,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(help);
  process.exitCode = 1;
};

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
