# Changelog

All notable, user-visible changes to verit and its GitHub Action. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`Added`, `Changed`, `Fixed`, `Removed` group each version. The compatibility of
every input and env var across versions lives in
[`docs/compatibility.md`](docs/compatibility.md).

## [0.4.0] - 2026-08-22

### Added

- Lane quality tiers. `VERIT_LANE_TIER` and the `lane-tier` action input pick
  `fast`, `balanced`, or `max`. You choose a tier, not a model. `balanced` and
  `max` run a cheap triage map pass that ranks the risky regions of the net
  diff, then the judge writes the Understanding with that focus. `fast` is a
  single judge call. Each tier maps to swappable model slugs, overridable per
  `VERIT_LANE_TIER_<TIER>_JUDGE` and `VERIT_LANE_TIER_<TIER>_TRIAGE`. OpenRouter
  is the recommended path: one key, any model.

### Changed

- `VERIT_LANE_MODEL` and `lane-model` are now an optional judge override, not
  required. Set either as a legacy single pin: one model, one pass, whatever the
  tier. It moves the judge and drops the triage pass, so an existing single-model
  setup makes the exact same one call it always did. Unset, the tier picks the
  judge. To keep a tier's triage with a custom judge, override the per-tier judge
  slug instead.

## [0.3.1] - 2026-08-21

### Fixed

- The release workflow proves the action before it pushes the tag, so a failed
  prove can no longer leave a tag on origin.
- README and this changelog name the yanked tag honestly. `@v0` now tracks the
  latest release.

## [0.3.0] - 2026-08-21

The first release meant for use. The one earlier tag, `v0.1.0`, is yanked, see
the note at the bottom.

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

## [0.1.0] - YANKED

Do not use this tag.

- The Understanding was a silent stub. The action posted a Check without the
  real analysis the Check implied.
- The install was broken. The action installed only itself, never the reviewed
  repo's dependencies, so prove could not run in a repo that needed
  `node_modules`, and a healthy pull request failed for the wrong reason.

`@v0` now points at a proven release. Pin `@v0` for the latest, or an exact
`vX.Y.Z` to hold a version.
