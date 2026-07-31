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
- **Pi harness** stub until `CYCLOPS_PI_BIN` is set
- **json-render** proof UI (`@cyclops/web`)

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

## CLI

```bash
pnpm cli ingest .
pnpm cli compile-pack
pnpm cli understand --dry-run
pnpm cli review --pr owner/repo#n
pnpm --filter @cyclops/web dev   # proof page → http://localhost:5173
```

## Dogfood

GitHub Action [`.github/workflows/dogfood.yml`](.github/workflows/dogfood.yml) targets
[solana-foundation/pay#415](https://github.com/solana-foundation/pay/pull/415).
Artifacts land under `.data/proofs/`.

## Packages

| Package | Role |
|---|---|
| `@cyclops/domain` | Pure schemas & entities |
| `@cyclops/ports` | Interfaces |
| `@cyclops/application` | Use-cases |
| `@cyclops/adapters-*` | SQLite, Neo4j, tree-sitter, GitHub, Pi, … |
| `@cyclops/cli` | `ingest` / `ingest-pr` / `understand` / `review` / `compile-pack` |
| `@cyclops/web` | json-render proof page |
| `@cyclops/action` | GitHub Action entry |
