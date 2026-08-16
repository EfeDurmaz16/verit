# verit

**The verification layer above your AI reviewers.**

AI reviewers give you opinions. verit gives you evidence.

A reviewer bot reads your diff and tells you what it thinks might break. That is
useful, and it is still an opinion. verit runs your repository's own tests
against the pull request, records the real exit code, and posts the result as a
`verit / behavior-proof` GitHub Check. If the tests did not run, the Check is
`neutral`. It never turns green on a guess.

Alongside the proof it publishes an **Understanding**: what the change does, why,
and how, with risks split into the ones the author declared and the ones the
review found. Author risks are hints. They are never treated as an allowlist.

Open source, AGPL-3.0. Self-host it for free.

---

## What lands on the pull request

```
verit / behavior-proof            Proof passed: pnpm test

  What changed:  Adds the pay gate commands to the CLI.
  Why:           Gate checks were only reachable through the HTTP API.
  How:           New verbs in cli/src/gate.ts routed to the existing service.

  Risks:         5 in total. 3 found by review.

  ## Proof
  `pnpm test` ran in `owner/repo` and exited **0** after 41.2s.
  Command source: `package.json`
  <details> Log tail </details>
```

Three states, and only three:

| Check conclusion | What it means |
|---|---|
| `success` | The repository's own verification command ran and exited 0. |
| `failure` | It ran and exited non-zero, or it timed out. |
| `neutral` | Nothing ran. You have an Understanding and no proof. |

---

## Quickstart

Add one workflow. That is the whole install.

```yaml
# .github/workflows/verit.yml
name: verit
on: pull_request
permissions:
  contents: read
  checks: write
  pull-requests: read
jobs:
  behavior-proof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: EfeDurmaz16/verit@main
```

verit detects the verification command from your repository. Override it when
the guess is wrong:

```yaml
      - uses: EfeDurmaz16/verit@main
        with:
          prove-command: cargo test --all
```

The Understanding is written by a headless coding CLI. With no key configured
you get a deterministic stub, which is honest but thin. To get the real thing:

```yaml
      - uses: EfeDurmaz16/verit@main
        with:
          lane-harness: claude
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Fork pull requests receive no secrets and a read-only token. verit degrades to
a dry run and prints the Check instead of posting it. That is deliberate, and it
is never a failed job.

Every input is listed in [`action.yml`](action.yml).

---

## Self-host the review workspace

The workspace is the live surface: paste a pull request URL and watch the
review assemble, instead of waiting for a Check to appear.

```bash
git clone https://github.com/EfeDurmaz16/verit
cd verit
pnpm install
pnpm workspace          # http://localhost:3000
```

Node 22 and pnpm 11. Needs `gh` authenticated, and one of `codex`, `claude` or
`cursor` on PATH for live analysis. No Docker, no database, no account. The
graph store falls back to memory and runs land in `.data/`.

Run the same pipeline headless:

```bash
pnpm cli review --pr=owner/repo#123
```

Prove stays off until you point it at a checkout of the repository you are
reviewing. It refuses every other checkout, so reviewing a stranger's pull
request never executes their code on your machine:

```bash
VERIT_PROVE_CWD=/path/to/that/repo pnpm cli review --pr=owner/repo#123
```

The hosted dashboard, with GitHub login and run history over Postgres, is
optional and documented in [`docs/dashboard-setup.md`](docs/dashboard-setup.md).

---

## How it compares

Checked August 2026. Corrections by pull request are welcome, with a link.

| | verit | CodeRabbit | Greptile | PR-Agent |
|---|---|---|---|---|
| Source | Open, AGPL-3.0 | Closed | Closed | Open, MIT |
| Self-host | Free | Paid enterprise contract | Paid enterprise contract | Free |
| Runs your repo's own test command | Yes, every run | No | No | No |
| Executes code at all | Yes | No | Yes, through TREX (beta) | No |
| Where the verdict comes from | A real process exit code | Model judgement | Model judgement, plus TREX sandbox runs | Model judgement |
| Check Run with a pass or fail conclusion | Yes, the conclusion is the exit code | Yes, from review state | Unverified | Comments only |
| Says "no proof" when nothing ran | Yes, `neutral` | No | No | No |

The honest version of the pitch: Greptile is the closest. Its TREX layer is a
real execution layer, not a marketing line. It spins up disposable sandboxes and
runs the changed code to confirm a suspected bug is real before reporting it.

The two differences that matter are what gets run, and who can run it.

**What gets run.** TREX has an agent write and drive scenarios. verit runs the
command your repository already defines, unchanged, and reports its exit code.
Nothing is inferred and nothing is generated. If your suite is good, the proof is
good. If your suite is weak, verit tells you it passed a weak suite rather than
claiming more than it checked.

**Who can run it.** TREX is proprietary and in beta, and Greptile self-hosting
needs an annual enterprise contract. verit is AGPL-3.0. Clone it and run it
today for nothing.

Everything else in that table analyzes the diff and writes about it. That is a
different job, and a useful one. verit sits above it: keep your reviewer, and
put a verdict underneath its opinion.

---

## How it works

```
  pull request
       │
       ▼
  ingest-pr ─────────► GraphStore        repo, PRs, edges (Neo4j, or memory)
       │                                  wiki pages and file symbols
       │
       ▼
  understand ────────► lane harness       one headless coding CLI reads the
       │                                  full diff, threads and CI logs
       │
       │  Understanding JSON              validated against the Effect Schema
       │  (what / why / how,              in @verit/domain. A run that fails
       │   risks, proof_refs)             validation is shown as unverified
       ▼
  prove ─────────────► ProvePort          runs the repo's OWN command as argv,
       │                                  in a checkout it confirmed is that
       │  exit code, duration,            repo. Fails closed on any mismatch
       │  log tail                        Timeout kills the process group
       ▼
  post ──────────────► CheckPort          verit / behavior-proof Check Run
       │                                  conclusion = exit code, nothing else
       ▼
  render ────────────► proof page         json-render Spec, one component
                                          registry shared by the workspace
                                          and the dashboard
```

The code is an Effect onion. `domain` holds pure schemas, `ports` holds
interfaces, `application` holds use cases, and every I/O concern is an adapter
behind a port. Swapping Neo4j for memory, or Codex for Claude Code, is swapping
one adapter.

Two stores by design. Neo4j holds the ontology and the pull request graph.
SQLite holds runs, proof blobs and full text chunks. Neither is required to try
verit: both have a memory or local fallback.

Architecture notes live in [`docs/architecture/`](docs/architecture/). The exact
meaning of every domain word is in [`CONTEXT.md`](CONTEXT.md).

---

## Hosted cloud

Self-hosting is free and always will be. A hosted version, with run history,
org-wide dashboards and no infrastructure to run, is coming.

**Waitlist: TODO add link before launch**

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | unset | Optional for public PRs. Needs `checks:write` to post the Check |
| `VERIT_PROVE_CWD` | `GITHUB_WORKSPACE` | Checkout prove runs in. Must be the reviewed repo |
| `VERIT_PROVE_CMD` | detected | Override the command, e.g. `cargo test --all`. Argv, never a shell string |
| `VERIT_PROVE_TIMEOUT_MS` | `600000` | Hard timeout. The process group is killed |
| `VERIT_CHECK_DRY_RUN` | unset | `1` prints the Check body instead of posting it |
| `VERIT_LANE_HARNESS` | `codex` | Coding CLI behind the analysis lane: `codex`, `claude` or `cursor`. An unknown value is an error, never a silent fallback |
| `VERIT_LANE_MODEL` | unset | Model for the analysis lane |
| `VERIT_LANE_TIMEOUT_MS` | `900000` | Hard timeout for the one-shot lane call |
| `ANTHROPIC_API_KEY` | unset | Auth for `VERIT_LANE_HARNESS=claude` in CI. Locally the CLI's own login is used |
| `CURSOR_API_KEY` | unset | Auth for `VERIT_LANE_HARNESS=cursor` in CI. Locally `cursor-agent login` is used |
| `VERIT_SQLITE_PATH` | `.data/verit.db` | DocumentStore path. Set `""` for in-memory |
| `VERIT_NEO4J_URI` | unset | `bolt://…`. Memory graph if unset |
| `VERIT_NEO4J_PASSWORD` | none | Neo4j auth when the URI is set |
| `VERIT_WORKSPACE_DIR` | `.data/workspace` | Workspace session blobs |
| `VERIT_PI_BIN` | unset | Path to a Pi binary. If unset, the deterministic stub |
| `VERIT_DASHBOARD_URL` | unset | Dashboard base URL. With `VERIT_INGEST_TOKEN` the run is uploaded and the Check links its proof page |
| `VERIT_INGEST_TOKEN` | unset | Per-repo ingest token from `pnpm --filter @verit/dashboard register-repo owner/name` |
| `PROOF_PAGE_URL` | unset | Only to override the computed proof page link |

## CLI

```bash
pnpm cli ingest .                       # index a repo: files, symbols, wiki, chunks
pnpm cli ingest-pr owner/repo#123       # fetch a PR plus explicit and inferred edges
pnpm cli understand --dry-run           # stub Understanding into the store and a proof Spec
pnpm cli review --pr=owner/repo#123     # classify, understand, render the proof Spec
pnpm cli compile-pack                   # emit the review skills.toml from presets
pnpm cli dogfood owner/repo#123         # the full Action path, locally
pnpm workspace                          # live review workspace on :3000
```

Proof artifacts land in `.data/proofs/`, which is gitignored.

## Packages

| Package | Role |
|---|---|
| `@verit/domain` | Pure schemas and entities |
| `@verit/ports` | Interfaces |
| `@verit/application` | Use cases |
| `@verit/adapters-*` | SQLite, Neo4j, tree-sitter, GitHub, Pi, prove, S3, memory |
| `@verit/cli` | `ingest`, `ingest-pr`, `understand`, `review`, `dogfood` |
| `@verit/workspace` | Live review workspace (Next.js, SSE, json-render) |
| `@verit/dashboard` | Hosted run history and proof pages (Next.js, Postgres) |
| `@verit/proof-ui` | The one component registry both surfaces render |
| `@verit/action` | GitHub Action entry point |

## Status

Early. The pieces below are real and running in this repository's own CI on
every pull request:

- `prove` running a repository's own command and reporting the true exit code
- the `verit / behavior-proof` Check Run, including the `neutral` case
- the Understanding schema, its validation, and the proof page render
- the GitHub Action, the CLI and the live workspace

Known gaps, stated plainly:

- tree-sitter ingest falls back to regex until the WASM grammars ship
- the suggested patch is a stub, not a real patch
- inline review comments are not implemented
- the hosted dashboard works but has had one operator, so treat its setup
  documentation as a first draft

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). Read [`STYLE.md`](STYLE.md) before writing
any string a human will read.

Security reports go to efe@sardis.sh, not to the issue tracker.
See [`SECURITY.md`](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE).
