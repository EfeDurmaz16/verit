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
| `success` | The repository's own verification command ran and exited 0. Every suite, when the repo has more than one. |
| `failure` | It ran and exited non-zero, or it timed out. Any one suite failing fails the run. |
| `neutral` | Nothing ran, or the analysis was partial. You have an Understanding and no full proof. |

A required check counts `neutral` as a pass, so `neutral` alone does not block a
merge. Set `fail-on: failure` to gate it: an inconclusive proof then maps to
`failure`. A polyglot repo runs one suite per language (Go, Rust, Python, Node,
and more) and folds them into one conclusion.

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
      - uses: EfeDurmaz16/verit@v0
```

verit detects the verification command from your repository: `package.json`,
`Cargo.toml`, `pyproject.toml`, `go.mod`, a `Makefile` with a `test` target,
`gradlew` or `pom.xml`, a `Gemfile`, `composer.json`, or a `.csproj`. A repo
with several of these runs one suite per language and reports one conclusion.
It never runs a build as a stand-in for tests: a compile is not a behavior
proof.

Tests that need dependencies will not run against a fresh checkout. If your
repository needs `node_modules` or any other install, run it before prove with
`install-command`:

```yaml
      - uses: EfeDurmaz16/verit@v0
        with:
          install-command: pnpm install --frozen-lockfile
```

`install-command` runs in the checkout under review, the same place prove runs,
so `npm ci`, `pip install -r requirements.txt`, or your own setup works here.
Leave it empty and verit installs nothing for you: install in an earlier
workflow step instead. Without either, a repository that needs dependencies
gets a prove failure, not a real test result.

Override the detected command when the guess is wrong:

```yaml
      - uses: EfeDurmaz16/verit@v0
        with:
          prove-command: cargo test --all
```

Make a required check block a merge unless the behavior is actually proven:

```yaml
      - uses: EfeDurmaz16/verit@v0
        with:
          fail-on: failure
```

Gate a later step on the result with the action's outputs:

```yaml
      - uses: EfeDurmaz16/verit@v0
        id: verit
      - if: steps.verit.outputs.conclusion == 'failure'
        run: echo "behavior not proven, see ${{ steps.verit.outputs.proof-page-url }}"
```

The step exposes `conclusion` (`success`, `failure`, or `neutral`), `run-id`,
and `proof-page-url`.

The Understanding is written by the analysis lane. Bring an API key, pin a
model, and the built-in lane talks straight to the model API. No coding CLI
is involved. With no key configured, no Understanding is written and the
Check is `neutral`. To get the real thing:

```yaml
      - uses: EfeDurmaz16/verit@v0
        with:
          lane-provider: anthropic
          lane-model: claude-opus-5
          lane-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

`lane-provider` takes `anthropic` or `openai-compat`. The `openai-compat`
provider plus `lane-base-url` covers OpenAI, Grok, DeepSeek, GLM, and a local
vLLM. A model is required: the lane pins its model and never guesses one.
The same settings also work as `VERIT_LANE_*` env on the step; a non-empty
input wins over the env. On a fork pull request secrets are withheld, the
lane disables itself, and the Check is `neutral`, never a failed job.

Legacy path: the `lane-harness: claude` and `lane-harness: cursor` inputs still
drive those headless coding CLIs, and are used only when no lane provider is
set.

Fork pull requests receive no secrets and a read-only token. verit degrades to
a dry run and prints the Check instead of posting it. That is deliberate, and it
is never a failed job.

Every input is listed in [`action.yml`](action.yml). The version each input and
env var appeared in, and when it changes, is in
[`docs/compatibility.md`](docs/compatibility.md). Released changes are in
[`CHANGELOG.md`](CHANGELOG.md). `@v0` tracks the latest release; pin an exact
`vX.Y.Z` if you want to hold a version. Do not pin `v0.1.0`: it shipped a stub
Understanding and a broken install and is yanked.

### Choosing models

Two tiers cover the pipeline. A cheap fast model handles the mechanical
passes: triage, summaries, diffs that net down to little after moves are
factored out. A strong model reads the must-review regions: auth, payments,
migrations, whatever the review plan ranks highest.

Numbers from the Artificial Analysis Intelligence Index v4.1.1, August 2026:

| Tier | Model | Index | Cost per task | Notes |
|---|---|---|---|---|
| Triage | GPT-5.6 Luna high | 47 | $0.02 | 178 tok/s, 1M context, $0.20 in / $1.20 out per M tokens |
| Judgment | Grok 4.6 high | 61 | $0.84 | Cheapest of the strong three |
| Judgment | Claude Opus 5 | 63 | $2.34 | Highest index |
| Judgment | Claude Fable 5 | 62 | $3.14 | Pareto-dominated: Opus 5 scores higher for less |

Model names live in this README on purpose. The code only knows tiers, and
rankings shift quarterly. Update this table, not the code.

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

Node 22 and pnpm 11. Needs `gh` authenticated, plus `VERIT_LANE_PROVIDER` and an
API key for live analysis. The tier picks the model, see [Choosing a
tier](#choosing-a-tier). On that provider path the
review is the same built-in HTTP lane the Action runs, straight against the
model API: no coding CLI, no Docker, no database, no account. The graph store
falls back to memory and runs land in `.data/`.

With no `VERIT_LANE_PROVIDER` set, the workspace falls back to a headless
coding CLI, `codex` by default or `claude`/`cursor` via `VERIT_LANE_HARNESS`,
and needs that binary on your `PATH`. The command-bar follow-ups drive that
same CLI, so they need it too. The core review does not.

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
  understand ────────► analysis lane      the model you pinned reads the NET
       │                                  diff, moves factored out first,
       │                                  plus threads and CI logs
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

### Net diff

Most of a large diff is moved code. Before any model call, `@verit/netdiff`
factors moves out deterministically and keeps what a reviewer must actually
read: new code, residual edits inside moved blocks, and deletions. Residuals
resolve down to token level: a moved block that changed by three words shows
exactly those three words.

The code is an Effect onion. `domain` holds pure schemas, `ports` holds
interfaces, `application` holds use cases, and every I/O concern is an adapter
behind a port. Swapping Neo4j for memory, or one lane provider for another, is
swapping one adapter.

Two stores by design. Neo4j holds the ontology and the pull request graph.
SQLite holds runs, proof blobs and full text chunks. Neither is required to try
verit: both have a memory or local fallback.

Architecture notes live in [`docs/architecture/`](docs/architecture/). The exact
meaning of every domain word is in [`CONTEXT.md`](CONTEXT.md).

---

## Hosted cloud

Self-hosting is free and always will be. A hosted version, with run history,
org-wide dashboards and no infrastructure to run, is coming.

Want in early? Email [efe@sardis.sh](mailto:efe@sardis.sh) with "verit" in the
subject.

### Subprocessors

The hosted dashboard runs on these third parties. Self-hosting removes all of
them except the model provider, which is your own account.

| Subprocessor | Role |
|---|---|
| GitHub | Source of the code and pull requests, and the repo read-access answer |
| Neon | Postgres host for run history and access cache |
| Vercel | Dashboard hosting |
| Cloudflare R2 | Object storage for prove logs |
| The lane model provider | Runs the review model. Anthropic by default, or whatever `VERIT_LANE_PROVIDER` names |

Full field-by-field detail, retention windows, and who can read what:
[`docs/data.md`](docs/data.md).

---

## Choosing a tier

The lane has one quality knob, `VERIT_LANE_TIER`. You pick a tier, not a model.
Set it on the Action with `lane-tier`, or as an env var. The default is
`balanced`.

- `fast`: one judge call on the full net diff. Lowest cost and latency. Good
  for large or low-risk pull requests where you want a quick read.
- `balanced`: a cheap triage pass reads the whole diff and ranks the risky
  regions first, then a mid-tier judge writes the Understanding with that focus.
  The default. Best cost-to-signal for most reviews.
- `max`: the same triage pass, then the strongest judge. Use it on money paths,
  auth, or anywhere a missed risk is expensive.

The triage pass is an optimization, never a gate. If it fails, times out, or
returns junk, the judge still runs on the full net diff. Triage can sharpen the
review, never block it or skew it.

### Tier to model

This table is the only place model names appear. Every slug is a default you can
swap without a code change, using the override var in the last column. The
defaults are current OpenRouter slugs.

| Tier | Triage map pass | Judge | Override vars |
|---|---|---|---|
| fast | none | `openai/gpt-5.6-luna` | `VERIT_LANE_TIER_FAST_JUDGE` |
| balanced | `openai/gpt-5.6-luna` | `anthropic/claude-sonnet-5` | `VERIT_LANE_TIER_BALANCED_TRIAGE`, `VERIT_LANE_TIER_BALANCED_JUDGE` |
| max | `openai/gpt-5.6-luna` | `anthropic/claude-opus-5` | `VERIT_LANE_TIER_MAX_TRIAGE`, `VERIT_LANE_TIER_MAX_JUDGE` |

`VERIT_LANE_MODEL` is the legacy single pin: set it and the run is one model,
one pass, whatever the tier. It moves the judge and drops the triage pass, so an
existing single-model setup makes the exact same one call it always did, never a
second cross-provider triage call it never asked for. To keep a tier's triage
with a different judge, override the per-tier judge slug instead (the last column
above).

### OpenRouter is the recommended path

The default slugs assume [OpenRouter](https://openrouter.ai): one API key reaches
every model behind one `openai-compat` base URL, so a tier can mix an OpenAI
triage model with an Anthropic judge on a single key. Point the lane at it:

```bash
export VERIT_LANE_PROVIDER=openai-compat
export VERIT_LANE_BASE_URL=https://openrouter.ai/api/v1
export VERIT_LANE_API_KEY=sk-or-...
export VERIT_LANE_TIER=balanced
```

Any other openai-compatible endpoint works too. To pin one native provider
instead, set `VERIT_LANE_PROVIDER=anthropic` and override the tier slugs, or set
`VERIT_LANE_MODEL`, to that provider's own model ids.

---

## Review mode

Besides the Understanding, verit can act as a co-equal reviewer. `VERIT_LANE_MODE`
(or the `lane-mode` Action input) picks what the lane produces:

- `understanding`: summarize only. What the change does, why, how to verify it,
  and where the risk is. This is the pre-review behavior, unchanged.
- `review`: lean on finding real problems. The judge still writes a valid
  Understanding, but the emphasis is on located findings.
- `both` (the default): summarize AND hunt.

A finding is a risk the judge points at one changed line for: a bug, an unsafe
path, a missing check. When the mode reviews, a skeptic pass tries to REFUTE
each located finding from the same net diff, and drops every finding it cannot
confirm. A finding whose call errors, times out, or returns junk is dropped too,
and a finding whose line the PR head does not change is dropped as a guessed
location. The result is a short list that survived a refutation, not a nit flood.

Findings are advisory. They render as inline annotations on the changed lines,
but they never change the Check conclusion. Only the proof result and `fail-on`
decide pass, fail, or neutral. If the whole analysis fails, the lane returns no
Understanding and the Check is neutral with zero findings, never a false green.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | unset | Optional for public PRs. Needs `checks:write` to post the Check |
| `VERIT_PROVE_CWD` | `GITHUB_WORKSPACE` | Checkout prove runs in. Must be the reviewed repo |
| `VERIT_PROVE_CMD` | detected | Override the command. A string splits on whitespace, e.g. `cargo test --all`; a JSON array is exact argv, e.g. `["pnpm","test","--","my case"]`, for an argument with spaces. Argv, never a shell string |
| `VERIT_PROVE_TIMEOUT_MS` | `600000` | Hard timeout. The process group is killed |
| `VERIT_FAIL_ON` | `never` | `failure` gates the Check: an inconclusive proof (nothing ran, refused, no command found, or partial coverage) maps to `failure` instead of `neutral`, since a required check counts `neutral` as a pass. `never` keeps today's behavior |
| `VERIT_CHECK_DRY_RUN` | unset | `1` prints the Check body instead of posting it |
| `VERIT_FORCE_NEUTRAL` | unset | Incident freeze. Any non-empty reason forces every Check to `neutral`, whatever the proof said. Only downgrades a claim, never invents one. See [`docs/runbook.md`](docs/runbook.md) |
| `VERIT_REFUSAL_REASON` | Why verit declined a privileged event. The action gate sets it, the neutral Check renders it |
| `VERIT_BASE_SHA` | unset | The pull request's base commit. Without one there is no differential to run |
| `VERIT_REPO_VISIBILITY` | unset | `public` or `private`. Decides the default for the shared execution memory |
| `VERIT_CORPUS_OPT_OUT` | unset | `1` keeps this repository's normalized run metadata out of the corpus |
| `VERIT_CORPUS_OPT_IN` | unset | `1` lets a private repository's normalized run metadata join the corpus |
| `VERIT_JOB_SPEC_SECRET` | unset | Secret the execution job spec is signed with |
| `VERIT_LANE_PROVIDER` | unset | `anthropic` or `openai-compat` turns on the built-in HTTP lane, the default path whenever it is set. An unknown value is an error, never a silent fallback |
| `VERIT_LANE_TIER` | `balanced` | The one quality knob: `fast`, `balanced`, or `max`. `fast` is a single judge call; `balanced` and `max` add a cheap triage map pass first. Maps to models in [Choosing a tier](#choosing-a-tier); every slug is swappable per var. An unknown value falls back to `balanced`, never an error, so a tier typo softens the review, it never fails the run |
| `VERIT_LANE_MODE` | `both` | What the lane produces: `understanding`, `review`, or `both`. `understanding` summarizes only. `review` and `both` also hunt located findings, then a skeptic pass refutes each one and drops the ones it cannot confirm. Findings are advisory: they annotate the diff, they never change the Check conclusion. See [Review mode](#review-mode). An unknown value falls back to `both` |
| `VERIT_LANE_MODEL` | unset | Legacy single pin: one model, one pass. Overrides the judge for any tier and drops the triage pass, so an existing single-model setup makes the same one call it always did. Unset, the tier picks the judge. To keep triage with a custom judge, use the per-tier judge override. Also the model override for the legacy CLI harnesses |
| `VERIT_LANE_BASE_URL` | provider default | API base URL override. `openai-compat` covers OpenAI, Grok (`https://api.x.ai/v1`), DeepSeek, GLM, and local vLLM |
| `VERIT_LANE_API_KEY` | unset | Lane API key. Falls back to `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to match the provider |
| `VERIT_LANE_MAX_TURNS` | `40` | Lane model-call cap |
| `VERIT_LANE_MAX_TOTAL_TOKENS` | `4000000` | Lane total token cap |
| `VERIT_LANE_TIMEOUT_MS` | `900000` | Hard timeout for the lane |
| `VERIT_LANE_HARNESS` | unset | Legacy: `claude` or `cursor` asks that headless coding CLI, only when no `VERIT_LANE_PROVIDER` is set |
| `ANTHROPIC_API_KEY` | unset | Auth for the `anthropic` provider, or for `VERIT_LANE_HARNESS=claude` in CI |
| `CURSOR_API_KEY` | unset | Auth for `VERIT_LANE_HARNESS=cursor` in CI. Locally `cursor-agent login` is used |
| `VERIT_SQLITE_PATH` | `.data/verit.db` | DocumentStore path. Set `""` for in-memory |
| `VERIT_NEO4J_URI` | unset | `bolt://…`. Memory graph if unset |
| `VERIT_NEO4J_USER` | `neo4j` | Neo4j username when the URI is set |
| `VERIT_NEO4J_PASSWORD` | none | Neo4j auth when the URI is set |
| `VERIT_WORKSPACE_DIR` | `.data/workspace` | Workspace session blobs |
| `VERIT_PI_BIN` | unset | Path to a Pi binary for the legacy Pi harness. If unset, that harness produces no Understanding |
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
pnpm cli doctor                         # check gh auth, node/pnpm, lane config, prove cwd
pnpm workspace                          # live review workspace on :3000
```

`doctor` exits non-zero on a real problem: a lane you opted into but did not
finish configuring, a prove cwd that does not exist, a node too old to run
verit. It warns, and still exits zero, on the rest.

Proof artifacts land in `.data/proofs/`, which is gitignored.

## Packages

| Package | Role |
|---|---|
| `@verit/domain` | Pure schemas and entities |
| `@verit/ports` | Interfaces |
| `@verit/application` | Use cases |
| `@verit/adapters-*` | SQLite, Neo4j, tree-sitter, GitHub, Pi, prove, S3, memory |
| `@verit/cli` | `ingest`, `ingest-pr`, `understand`, `review`, `dogfood`, `doctor` |
| `@verit/workspace` | Live review workspace (Next.js, SSE, json-render) |
| `@verit/dashboard` | Hosted run history and proof pages (Next.js, Postgres) |
| `@verit/proof-ui` | The one component registry both surfaces render |

## Status

Early. The pieces below are real and running in this repository's own CI on
every pull request:

- `prove` running a repository's own command and reporting the true exit code
- the `verit / behavior-proof` Check Run, including the `neutral` case
- the Understanding schema, its validation, and the proof page render
- the GitHub Action, the CLI and the live workspace

Known gaps, stated plainly:

- tree-sitter ingest is real for TypeScript, TSX, JavaScript, Python, Rust and
  Go. The grammar wasm files ship inside the grammar npm packages, so
  `pnpm install` is the only fetch and CI needs no compiler toolchain. Files in
  other languages use the regex fallback parser.
- the suggested patch is a stub, not a real patch
- inline review comments are not implemented
- the hosted dashboard works but has had one operator, so treat its setup
  documentation as a first draft

## Roadmap

1. **Suggested proof.** When the review finds a risk, verit will write the
   smallest failing test that would prove it, run it through prove in the
   same checkout, and attach the real exit code. A confirmed risk arrives
   with evidence. A refuted one is dropped. verit will keep refusing to
   suggest fix diffs: the fix belongs to the author, the proof belongs to
   the reviewer.
2. **Multi-suite prove.** Monorepos with per-language test commands get one
   proof per suite instead of one detected command.
3. **Hosted verit.** Org-wide install, run history, memory across pull
   requests, and a fan-out engine for pull requests too large for one
   context window.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). Read [`STYLE.md`](STYLE.md) before writing
any string a human will read.

Security reports go to efe@sardis.sh, not to the issue tracker.
See [`SECURITY.md`](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE).
