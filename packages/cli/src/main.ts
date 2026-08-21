#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import {
  behaviorProofCheck,
  buildReviewContext,
  changedHeadLines,
  compileReviewPack,
  inferEmbeddingSimilarEdges,
  inferSameAuthorPathEdges,
  runProve,
  runReviewUnderstand,
} from "@verit/application";
import { ingestRepoPath } from "@verit/adapter-fs-ingest";
import { makeGithubChecks, makeGithubVcs } from "@verit/adapter-github";
import { gitState, makeProveRunner } from "@verit/adapter-prove";
import { makeLocalBlob } from "@verit/adapter-local-blob";
import {
  makeHeuristicClassifier,
  makeMemoryDocumentStore,
  makeProofRender,
} from "@verit/adapter-memory";
import { makeGraphStore } from "@verit/adapter-neo4j";
import { makeAgentHarness } from "@verit/adapter-pi";
import { laneEnabled, makeLaneHarness } from "@verit/lane";
import { makeSqliteDocumentStore } from "@verit/adapter-sqlite";
import { makeTreeSitterParser } from "@verit/adapter-treesitter";
import type { PullRequest, ReviewPresets, ReviewRun, Understanding } from "@verit/domain";
import type { DocumentStore, GitState, ProveOutcome } from "@verit/ports";
import { buildUpload, dashboardTarget, proofPageUrl, uploadRun } from "./upload";

const help = `verit <command>

Commands:
  ingest <path>              Index repo (files, symbols, wiki, chunks)
  ingest-pr owner/repo#n     Fetch PR + explicit/inferred edges
  understand --dry-run       Stub/Pi understand → DocumentStore + proof Spec
  review --pr owner/repo#n   Classify → understand → proof Spec (.data/proofs)
  compile-pack               Emit review skills.toml from presets
  dogfood owner/repo#n       ingest-pr → compile-pack → review (Action mirror)

Env:
  GITHUB_TOKEN          optional for public PRs; needs checks:write to post a Check
  VERIT_SQLITE_PATH   default .data/verit.db (set empty to use memory)
  VERIT_LANE_PROVIDER anthropic | openai-compat runs the built-in HTTP lane, the
                        default whenever it is set. No coding CLI is involved
  VERIT_LANE_MODEL    model id for the lane. Required with VERIT_LANE_PROVIDER:
                        the lane pins its model and never guesses one.
                        Optional model override for the CLI harnesses below
  VERIT_LANE_BASE_URL API base URL override. openai-compat covers OpenAI, Grok
                        (https://api.x.ai/v1), DeepSeek, GLM, and local vLLM
  VERIT_LANE_API_KEY  lane API key. Falls back to ANTHROPIC_API_KEY or
                        OPENAI_API_KEY to match the provider
  VERIT_LANE_MAX_TURNS       lane model-call cap, default 40
  VERIT_LANE_MAX_TOTAL_TOKENS  lane total token cap, default 4000000
  VERIT_LANE_HARNESS  claude | cursor asks that headless CLI for the Understanding
                        when no VERIT_LANE_PROVIDER is set; anything else keeps
                        the Pi path. Any failure means no Understanding, and
                        the Check is neutral
  VERIT_LANE_TIMEOUT_MS  hard timeout for the lane, default 900000
  VERIT_PI_BIN        optional Pi binary for the legacy Pi harness; unset means
                        that harness produces no Understanding
  VERIT_PI_ARGS       optional args (default: understand --json)
  VERIT_NEO4J_URI     optional bolt://… (memory graph fallback if unset)
  VERIT_PROVE_CWD     checkout to prove in (default GITHUB_WORKSPACE); prove is
                        refused unless that checkout IS the reviewed repo
  VERIT_PROVE_CMD     override the detected command. A string splits on
                        whitespace, e.g. "cargo test --all"; a JSON array is
                        exact argv, e.g. ["pnpm","test","--","my case"]
  VERIT_PROVE_TIMEOUT_MS  hard timeout, default 600000
  VERIT_FAIL_ON       failure | never (default never). failure gates the Check:
                        an inconclusive proof (nothing ran, refused, no command,
                        or partial) fails instead of passing as a neutral check
  VERIT_DASHBOARD_URL   base URL of the hosted dashboard. With VERIT_INGEST_TOKEN
                          the finished run is uploaded and the Check links its proof
                          page. Leave either unset and nothing is uploaded
  VERIT_INGEST_TOKEN    per-repo ingest token issued by the dashboard
  PROOF_PAGE_URL          overrides the computed proof page link in the Check
`;

const defaultPresets: ReviewPresets = {
  reviewer_identity: "normal",
  proof_frequency: "behavior_default",
  codebase_automation: "off",
  inline_comments: "high_conf_only",
  domain: "GENERAL",
};

/**
 * The Understanding lane for this run. Naming VERIT_LANE_PROVIDER selects the
 * built-in HTTP lane and pins its model; that is the default path. Unset, the
 * CLI-harness adapters (claude/cursor/pi) keep working as before.
 */
const makeHarness = () => (laneEnabled() ? makeLaneHarness() : makeAgentHarness());

const makeDocs = () => {
  const path = process.env.VERIT_SQLITE_PATH;
  if (path === "") return makeMemoryDocumentStore();
  return makeSqliteDocumentStore(path ?? ".data/verit.db");
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
  const path = await Effect.runPromise(
    blob.writeLocal(`${runId.replaceAll(":", "_")}.spec.json`, JSON.stringify(spec)),
  );
  await Effect.runPromise(blob.writeLocal("latest.spec.json", body));
  if (alias) {
    await Effect.runPromise(blob.writeLocal(alias, body));
  }
  return path;
};

/**
 * Run the reviewed repo's own verification command, but only when this
 * machine's checkout IS that repo. The port fails closed on any mismatch, so
 * reviewing a stranger's PR never executes their code here; in CI the runner's
 * checkout is the repo under review, which is where prove is meant to run.
 */
const proveIfPointedHere = async (
  docs: DocumentStore,
  runId: string,
  repo: string,
  understanding: Understanding | null,
  baseline: GitState | null,
): Promise<{ understanding: Understanding | null; outcome: ProveOutcome | null }> => {
  const cwd = process.env.VERIT_PROVE_CWD || process.env.GITHUB_WORKSPACE;
  if (!cwd) return { understanding, outcome: null };
  const timeoutMs = Number(process.env.VERIT_PROVE_TIMEOUT_MS) || undefined;
  try {
    return await Effect.runPromise(
      runProve({ prove: makeProveRunner(), docs })({
        runId,
        cwd,
        expectRepo: repo,
        understanding,
        timeoutMs,
        baseline,
      }),
    );
  } catch (e) {
    console.error(`prove skipped: ${e instanceof Error ? e.message : String(e)}`);
    return { understanding, outcome: null };
  }
};

const runUnderstandPipeline = async (input: {
  repoId: string;
  prId?: string;
  /** owner/repo of the reviewed PR: the only repo prove may run in. */
  repo?: string;
  title: string;
  body: string;
  paths: readonly string[];
  diff: string;
  context: ReturnType<typeof buildReviewContext>;
  alias?: string;
}) => {
  const docs = makeDocs();
  const graph = await makeGraphStore();
  // Snapshot the prove workspace before the lane runs. prove compares against
  // this and refuses if the tree moved during analysis. Only the review path
  // names a repo and points prove at a checkout, so only it has a baseline.
  const proveCwd = input.repo
    ? process.env.VERIT_PROVE_CWD || process.env.GITHUB_WORKSPACE
    : undefined;
  const baseline = proveCwd ? await gitState(resolve(proveCwd)) : null;
  const result = await Effect.runPromise(
    runReviewUnderstand({
      docs,
      graph,
      harness: makeHarness(),
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
  let understanding = result.understanding;
  if (understanding === null) {
    console.error("understand: the lane produced no Understanding, this run has no analysis");
  }
  let outcome: ProveOutcome | null = null;
  if (input.repo) {
    const proved = await proveIfPointedHere(
      docs,
      result.runId,
      input.repo,
      understanding,
      baseline,
    );
    understanding = proved.understanding;
    outcome = proved.outcome;
  }
  // Re-render so the Spec matches the Understanding after prove hung its ref on
  // it. Without an Understanding there is nothing to render and no spec to write.
  let enrichedSpec: unknown = null;
  let specPath: string | null = null;
  if (understanding !== null) {
    const render = makeProofRender();
    enrichedSpec = render.toSpec({
      understanding,
      context: input.context,
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
    });
    await Effect.runPromise(docs.saveUnderstandingJson(result.runId, understanding));
    const blob = makeLocalBlob();
    specPath = await writeProofArtifacts(blob, result.runId, enrichedSpec, input.alias);
  }
  return {
    runId: result.runId,
    run: result.run,
    spec: enrichedSpec,
    skillPackHash: result.skillPackHash,
    /** net chars, moves factored out: what the coverage check budgets against */
    diffChars: result.netDiffChars,
    /** The PR head's changed lines, per path: what a Check annotation anchors to. */
    changedLines: changedHeadLines(input.diff),
    what: understanding?.what ?? null,
    risks: understanding?.risks.length ?? 0,
    proofRefs: understanding?.proof_refs.length ?? 0,
    specPath,
    understanding,
    prove: outcome
      ? { command: outcome.command, exitCode: outcome.exitCode, durationMs: outcome.durationMs }
      : null,
    outcome,
  };
};

/**
 * The `post` verb: one Check Run on the commit this Action is running against.
 * Without a checks:write token it is a dry run. The body is printed, nothing
 * is posted, and no green check is ever invented for an unproven change.
 */
/** The GitHub Actions run this job belongs to, for the Check's Details link. */
const workflowRunUrl = (): string | undefined => {
  const server = process.env.GITHUB_SERVER_URL;
  const slug = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && slug && runId ? `${server}/${slug}/actions/runs/${runId}` : undefined;
};

const postBehaviorProofCheck = async (input: {
  understanding: Understanding | null;
  outcome: ProveOutcome | null;
  diffChars?: number;
  runId: string;
  proofPageUrl?: string;
  changedLines?: ReadonlyMap<string, ReadonlySet<number>>;
}) => {
  const slug = process.env.GITHUB_REPOSITORY;
  const headSha = process.env.VERIT_CHECK_SHA || process.env.GITHUB_SHA;
  if (!slug || !headSha) {
    console.error("post: no GITHUB_REPOSITORY/GITHUB_SHA, skipping check run");
    return null;
  }
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) return null;
  // fail-on gating: a required check counts neutral as a pass, so failure maps
  // an inconclusive proof to a hard failure. never (default) preserves today.
  const failOn = process.env.VERIT_FAIL_ON === "failure" ? "failure" : "never";
  const check = behaviorProofCheck({
    understanding: input.understanding,
    outcome: input.outcome,
    diffChars: input.diffChars,
    proofPageUrl: input.proofPageUrl,
    workflowRunUrl: workflowRunUrl(),
    changedLines: input.changedLines,
    failOn,
    runId: input.runId,
  });
  const dry = process.env.VERIT_CHECK_DRY_RUN === "1" || !process.env.GITHUB_TOKEN;
  if (dry) {
    console.error(`post (dry run) ${check.name} → ${check.conclusion}: ${check.title}`);
    console.error(check.summary);
    return { ...check, posted: false, url: null };
  }
  try {
    const posted = await Effect.runPromise(
      makeGithubChecks(process.env.GITHUB_TOKEN).postCheckRun({
        owner,
        repo,
        headSha,
        ...check,
      }),
    );
    console.error(`post: ${check.name} → ${check.conclusion} ${posted.url ?? ""}`);
    return { ...check, ...posted };
  } catch (e) {
    // a fork PR's token cannot write checks. Report the outcome, do not fail
    // the run over the announcement of it
    console.error(`post failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...check, posted: false, url: null };
  }
};

/** The pipeline result minus the bulky objects the caller keeps for itself. */
const printable = <
  T extends {
    understanding: Understanding | null;
    outcome: ProveOutcome | null;
    run: ReviewRun;
    spec: unknown;
    changedLines: ReadonlyMap<string, ReadonlySet<number>>;
  },
>(
  out: T,
): Omit<T, "understanding" | "outcome" | "run" | "spec" | "changedLines"> => {
  const { understanding: _u, outcome: _o, run: _r, spec: _s, changedLines: _c, ...rest } = out;
  return rest;
};

/** The PR fields the dashboard lists, plus the commit the runner is on. */
const prUpload = (pr: PullRequest) => ({
  number: pr.number,
  title: pr.title,
  url: pr.url,
  author: pr.author,
  headSha: process.env.VERIT_CHECK_SHA || process.env.GITHUB_SHA || undefined,
});

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
  const out = await runUnderstandPipeline({
    repoId: pr.repoId,
    prId: pr.id,
    repo: `${owner}/${repo}`,
    title: pr.title,
    body: pr.body ?? "",
    paths: changedPaths,
    diff,
    context,
    alias,
  });
  return { ...out, pr, repoSlug: `${owner}/${repo}` };
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
    if (!dry) throw new Error("usage: verit understand --dry-run");
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
    console.log(JSON.stringify(printable(out), null, 2));
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
    if (!prFlag) throw new Error("usage: verit review --pr=owner/repo#n");
    const { pr: _pr, ...out } = await reviewPr(prFlag.replace(/^--pr=/, ""));
    console.log(JSON.stringify(printable(out), null, 2));
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

    // Upload before the Check is posted, so the link in the Check body already
    // resolves. With either variable unset there is no upload and no link, and
    // the pipeline behaves exactly as it did before the dashboard existed.
    const target = dashboardTarget();
    const pageUrl =
      process.env.PROOF_PAGE_URL ||
      (target ? proofPageUrl(target.baseUrl, out.repoSlug, out.runId) : undefined);
    let upload: { uploaded: boolean; error?: string } | null = null;
    if (target && out.understanding !== null) {
      console.error(`dogfood: upload run to ${target.baseUrl}`);
      upload = await uploadRun(
        target,
        buildUpload({
          repo: out.repoSlug,
          run: out.run,
          understanding: out.understanding,
          proofSpec: out.spec,
          pr: prUpload(out.pr),
          outcome: out.outcome,
        }),
      );
      if (!upload.uploaded) console.error(`dashboard upload failed: ${upload.error}`);
    } else if (target) {
      console.error("dogfood: no Understanding, nothing to upload");
    }

    console.error(`dogfood: post check`);
    const check = await postBehaviorProofCheck({
      understanding: out.understanding,
      outcome: out.outcome,
      diffChars: out.diffChars,
      runId: out.runId,
      proofPageUrl: pageUrl,
      changedLines: out.changedLines,
    });
    const {
      understanding: _u,
      outcome: _o,
      run: _r,
      spec: _s,
      pr: _p,
      changedLines: _c,
      ...summary
    } = out;
    console.log(
      JSON.stringify(
        {
          ...summary,
          check: check
            ? { name: check.name, conclusion: check.conclusion, posted: check.posted, url: check.url }
            : null,
          proofPageUrl: pageUrl ?? null,
          upload,
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
