# Cyclops

Behavior-proof PR review — understanding-first harness, ontology graph, json-render proof pages.

Planning context lives in `proof-review`. This repo is the product.

## Stack

- Effect + hexagonal/onion packages
- SQLite (runs / artifacts / FTS chunks) + Neo4j (ontology / PR graph)
- tree-sitter ingest (regex fallback), Pi harness stub, json-render proof UI

## Quick start

```bash
pnpm install
docker compose up -d neo4j   # optional; without it graph falls back to memory
export CYCLOPS_NEO4J_URI=bolt://localhost:7687
export CYCLOPS_NEO4J_PASSWORD=cyclops-dev
pnpm test
pnpm typecheck
pnpm cli --help
pnpm cli ingest .
pnpm cli compile-pack
pnpm cli understand --dry-run
pnpm --filter @cyclops/web dev   # proof page at http://localhost:5173
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
