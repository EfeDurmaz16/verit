# Contributing

Thanks for looking. Small, focused pull requests get merged fastest.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

Node 22 and pnpm 11. The version is pinned by `packageManager` in `package.json`,
so `corepack enable` is enough to get the right one.

Neo4j and Postgres are optional. Without them the graph store falls back to
memory and the dashboard is simply not running. Every test passes without Docker.

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
```

Both must pass. CI runs the same two commands and nothing else.

## House rules

- Read [`STYLE.md`](STYLE.md) before writing any string a human will read.
  The short version: no em dash character, short sentences, active voice,
  name concrete files and behaviors.
- Read [`CONTEXT.md`](CONTEXT.md) for what the domain words mean. `Understanding`,
  `proof ref` and `prove` are exact terms, not loose ones.
- Conventional Commits, one logical change per commit.
- The onion order is `domain` then `ports` then `application` then adapters.
  A dependency that points the other way is a bug, not a shortcut.
- New behavior needs a test. `pnpm test` is the gate, not a suggestion.

## The part that matters most

`prove` executes code. It runs the reviewed repository's own verification
command in a checkout it has confirmed is that repository, and it fails closed
on any mismatch. If you touch `packages/adapters/prove` or
`packages/application/src/prove.ts`, assume the change is security relevant.
Say in the pull request body what the new failure mode is and why it still
refuses to run in the wrong checkout.

Never make the Check Run conclusion anything other than the real exit code of
the command that ran. A green check that nothing earned is the one bug this
project cannot ship.

## Reporting a vulnerability

Do not open an issue. See [`SECURITY.md`](SECURITY.md).

## License

Contributions are licensed under AGPL-3.0-only, the same as the project.
