# Architecture

cyclops is an Effect onion. Dependencies point one way only:

```
domain  →  ports  →  application  →  adapters
```

- **`packages/domain`** is pure. Schemas and entities, no I/O. `Understanding`,
  `ProofRef`, `ReviewRun` and the `OUTPUT_STYLE` contract live here.
- **`packages/ports`** is interfaces only. `GraphStore`, `DocumentStore`,
  `HarnessPort`, `ProvePort`, `CheckPort`, `ObjectStorePort`.
- **`packages/application`** is use cases. `runReviewUnderstand`, `runProve`,
  `behaviorProofCheck`, `compileReviewPack`, `buildReviewContext`.
- **`packages/adapters/*`** are the only places that touch the outside world.

A dependency that points the other way is a bug, not a shortcut.

## The two stores

| Store | Holds | Adapter | Fallback |
|---|---|---|---|
| `GraphStore` | Ontology, repos, PRs, PR edges, wiki pages | Neo4j | in-memory |
| `DocumentStore` | Runs, Understandings, proof blobs, FTS chunks | SQLite | in-memory |

Neither is required to run cyclops. Both fall back, which is why the quickstart
needs no Docker.

## The prove boundary

`prove` is the only part of cyclops that executes someone else's code, so it is
the part worth reading closely.

`packages/adapters/prove` spawns the reviewed repository's own verification
command as **argv**, never as a shell string, so nothing in a pull request title,
branch name or diff can be interpreted as shell. Before spawning, it confirms
the checkout it was pointed at is the repository under review, and fails closed
on any mismatch. A timeout kills the whole process group.

`packages/application/src/prove.ts` turns the outcome into a `ProofRef` with a
`pass` or `fail` status. `behaviorProofCheck` turns that, and only that, into the
Check Run conclusion. When nothing ran, the conclusion is `neutral`. There is no
code path that produces a passing Check without a passing run, and adding one
would be a security bug.

## The proof page

One json-render component registry, `@cyclops/proof-ui`, is rendered by both the
live workspace and the hosted dashboard. The renderer refuses any component that
is not in the catalog, and every prop coming from a model is validated
defensively, because model output is untrusted input.

## Reading order

Start at `packages/domain/src/index.ts`, then `packages/ports/src/index.ts`,
then `packages/application/src/run-review.ts`. `packages/cli/src/main.ts` wires
the whole thing together in one file and is the fastest way to see the shape.

Domain vocabulary is defined in [`../../CONTEXT.md`](../../CONTEXT.md).
Output style rules are in [`../../STYLE.md`](../../STYLE.md).
