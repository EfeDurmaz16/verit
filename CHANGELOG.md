# Changelog

All notable, user-visible changes to verit and its GitHub Action. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`Added`, `Changed`, `Fixed`, `Removed` group each version. The compatibility of
every input and env var across versions lives in
[`docs/compatibility.md`](docs/compatibility.md).

## [0.3.0] - Unreleased

The first release meant for use. Every `v0.x` tag before it is yanked, see the
note at the bottom.

### Fixed

- The action installs the reviewed repo's own dependencies before prove, in
  `GITHUB_WORKSPACE`, through the new `install-command` input. Before this the
  action installed only itself, in `github.action_path`, so a healthy JS pull
  request whose tests need `node_modules` got a false prove failure on the
  documented quickstart. (`action.yml`)

### Added

- `install-command` input. Set it to `pnpm install --frozen-lockfile`, `npm ci`,
  or your own install; it runs in `GITHUB_WORKSPACE` before prove. Empty keeps
  the old behavior: verit installs nothing for you, and a repo that needs
  dependencies must install them in an earlier workflow step.
- Action outputs `conclusion`, `run-id`, and `proof-page-url`, so a later
  workflow step can gate on the Check without re-parsing verit's stdout.
- `verit doctor`: a CLI subcommand that checks `gh` auth, node and pnpm
  versions, lane provider/model/key coherence, and the prove cwd, printing a
  specific reason per problem and exiting non-zero on a real one.
- [`docs/compatibility.md`](docs/compatibility.md): the version history of every
  action input and env var, with a test that fails when it drifts from
  `action.yml`, the code, or the README.
- `.github/workflows/release.yml`: a `workflow_dispatch` release flow that tags
  `vX.Y.Z` at main, proves the action at that exact tag, and only then, behind
  an off by default guard, moves the `v0` alias. Release notes come from the
  conventional commits since the last tag. Rollback is documented in the
  workflow and below.

## [0.2.0], [0.1.0], and earlier `v0.x` - YANKED

Do not use these tags. Do not use `@v0` while the `v0` alias still points into
this range (it currently points at `7a18fff`).

- The Understanding was a silent stub. The action posted a Check without the
  real analysis the Check implied.
- The install was broken. The action installed only itself, never the reviewed
  repo's dependencies, so prove could not run in a repo that needed
  `node_modules`, and a healthy pull request failed for the wrong reason.

Pin `0.3.0` or later once it is tagged. Moving the `v0` alias onto a proven
`0.3.0` is the fix for `@v0` callers, and is a deliberate manual step in the
release workflow.
