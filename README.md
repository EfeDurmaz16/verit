# Cyclops

Behavior-proof PR review: understanding-first harness, dual stores, generative proof UI.

Planning lives in [`proof-review`](https://github.com/EfeDurmaz16/proof-review). This repo is the product.

## What it does

Cyclops builds a canonical **Understanding** (what / why / how + proof refs and risks), then renders a **proof page** (json-render Spec) so humans can verify behavior, not just skim a chatty review.

The `prove` verb runs the reviewed repo's **own** test or build command and records the real exit code, duration and log tail as a proof ref. It refuses to run anywhere but a checkout of the repo under review: in CI that is the Action runner (the sandbox for v1), and in the workspace it only ever fires when you click the button that names the command. A failed proof renders as failed.

## Stack

- **Effect** onion: `domain` → `ports` → `application` → adapters
- **SQLite**: runs, proof blobs, FTS chunks (`DocumentStore`)
- **Neo4j**: ontology + PR/git graph (`GraphStore`; optional, memory fallback without Docker)
- **tree-sitter** ingest with **regex fallback** until WASM grammars ship
- **Harness port**: one headless coding CLI per lane, chosen with `CYCLOPS_LANE_HARNESS` (`codex`, `claude`, `cursor`); the Action falls back to Pi via `CYCLOPS_PI_BIN`, then to a deterministic stub
- **json-render** proof UI: the live review workspace (`@cyclops/workspace`, Next.js + SSE)
- **ProvePort**: child-process runner for the target repo's verification command; **CheckPort**: `cyclops / behavior-proof` Check Run

Architecture notes: [`docs/architecture/`](docs/architecture/). Domain terms: [`CONTEXT.md`](CONTEXT.md).

## Quick start

```bash
pnpm install
docker compose up -d neo4j   # optional
export CYCLOPS_NEO4J_URI=bolt://localhost:7687
export CYCLOPS_NEO4J_PASSWORD=cyclops-dev
pnpm test
pnpm typecheck
pnpm cli --help
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | unset | Optional for public PRs; raises rate limits |
| `CYCLOPS_SQLITE_PATH` | `.data/cyclops.db` | DocumentStore path; set `""` for in-memory |
| `CYCLOPS_PI_BIN` | unset | Path to Pi binary; if unset, deterministic stub |
| `CYCLOPS_PI_ARGS` | `understand --json` | Args passed to Pi (JSON Understanding on stdout) |
| `CYCLOPS_NEO4J_URI` | unset | `bolt://…`; memory graph if unset |
| `CYCLOPS_NEO4J_PASSWORD` | none | Neo4j auth when URI set |
| `CYCLOPS_WORKSPACE_DIR` | `.data/workspace` | Workspace session blobs |
| `CYCLOPS_LANE_HARNESS` | `codex` | Coding CLI behind the analysis lane: `codex`, `claude` or `cursor`. An unknown value is an error, never a silent fallback. The Action understands `claude` and `cursor`; on `codex` it keeps the Pi path |
| `CYCLOPS_LANE_MODEL` | unset | Model for the analysis lane, passed to whichever harness is selected |
| `CYCLOPS_LANE_TIMEOUT_MS` | `900000` | Hard timeout for the Action's one-shot lane call |
| `ANTHROPIC_API_KEY` | unset | Auth for `CYCLOPS_LANE_HARNESS=claude` in CI. Locally the CLI's own login is used |
| `CURSOR_API_KEY` | unset | Auth for `CYCLOPS_LANE_HARNESS=cursor` in CI. Locally `cursor-agent login` is used |
| `PR_SPEC` | `solana-foundation/pay#415` | Action / dogfood target |
| `CYCLOPS_PROVE_CWD` | `GITHUB_WORKSPACE` (CLI) / cwd (workspace) | Checkout prove runs in; must be the reviewed repo |
| `CYCLOPS_PROVE_CMD` | detected | Override the command, e.g. `cargo test --all` (argv, never a shell string) |
| `CYCLOPS_PROVE_TIMEOUT_MS` | `600000` | Hard timeout; the process group is killed |
| `CYCLOPS_CHECK_DRY_RUN` | unset | `1` prints the Check body instead of posting |
| `PROOF_PAGE_URL` | unset | Hosted proof page linked from the Check |

## CLI

```bash
pnpm cli ingest .
pnpm cli compile-pack
pnpm cli understand --dry-run
pnpm cli ingest-pr owner/repo#n
pnpm cli review --pr=owner/repo#n
pnpm cli dogfood solana-foundation/pay#415
pnpm workspace                   # live review workspace on http://localhost:3000
```

Artifacts land under `.data/proofs/` (gitignored).

Prove is off unless you point it at a checkout of the repo you are reviewing:

```bash
CYCLOPS_PROVE_CWD=/path/to/that/repo pnpm cli review --pr=owner/repo#n
```

## Dogfood pay#415 (local = CI)

Every pull request to this repo also dogfoods itself: the workflow reviews the
PR's own head commit, proves it by running `pnpm test` in the runner, and posts
the result as a `cyclops / behavior-proof` Check Run. On fork PRs the token is
read-only and the post degrades to a dry run.

Same path as [`.github/workflows/dogfood.yml`](.github/workflows/dogfood.yml):

```bash
pnpm install
pnpm cli dogfood solana-foundation/pay#415
# or Action mirror:
PR_SPEC=solana-foundation/pay#415 CYCLOPS_SQLITE_PATH=.data/cyclops.db \
  pnpm --filter @cyclops/action exec tsx src/run.ts
```

To watch the same review assemble live instead of reading the artifact:

```bash
pnpm workspace
# open http://localhost:3000 and paste https://github.com/solana-foundation/pay/pull/415
```

Requires `gh` (authenticated) and the `codex` CLI on PATH.

## Packages

| Package | Role |
|---|---|
| `@cyclops/domain` | Pure schemas & entities |
| `@cyclops/ports` | Interfaces |
| `@cyclops/application` | Use-cases |
| `@cyclops/adapters-*` | SQLite, Neo4j, tree-sitter, GitHub, Pi, prove, … |
| `@cyclops/cli` | `ingest` / `ingest-pr` / `understand` / `review` / `dogfood` |
| `@cyclops/workspace` | Live review workspace (Next.js, SSE, json-render) |
| `@cyclops/action` | GitHub Action entry (calls `dogfood`) |
