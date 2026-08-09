# Cyclops

Behavior-proof PR review — understanding-first harness, dual stores, generative proof UI.

Planning lives in [`proof-review`](https://github.com/EfeDurmaz16/proof-review). This repo is the product.

## What it does

Cyclops builds a canonical **Understanding** (what / why / how + proof refs and risks), then renders a **proof page** (json-render Spec) so humans can verify behavior — not just skim a chatty review.

## Stack

- **Effect** onion: `domain` → `ports` → `application` → adapters
- **SQLite** — runs, proof blobs, FTS chunks (`DocumentStore`)
- **Neo4j** — ontology + PR/git graph (`GraphStore`; optional — memory fallback without Docker)
- **tree-sitter** ingest with **regex fallback** until WASM grammars ship
- **Pi harness** via `CYCLOPS_PI_BIN`, else deterministic stub Understanding
- **json-render** proof UI — the live review workspace (`@cyclops/workspace`, Next.js + SSE)

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
| `CYCLOPS_NEO4J_PASSWORD` | — | Neo4j auth when URI set |
| `PR_SPEC` | `solana-foundation/pay#415` | Action / dogfood target |

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

## Dogfood pay#415 (local = CI)

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
| `@cyclops/adapters-*` | SQLite, Neo4j, tree-sitter, GitHub, Pi, … |
| `@cyclops/cli` | `ingest` / `ingest-pr` / `understand` / `review` / `dogfood` |
| `@cyclops/workspace` | Live review workspace (Next.js, SSE, json-render) |
| `@cyclops/action` | GitHub Action entry (calls `dogfood`) |
