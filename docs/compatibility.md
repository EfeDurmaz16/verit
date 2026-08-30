# Compatibility

Every action input, environment variable, and action output verit reads, the
version it appeared in, and the version it stops working. Use it to tell what a
given tag accepts before you pin to it.

History starts at the current surface. Tags `v0`, `v0.1.0`, `v0.2.0` are yanked:
they shipped a silent stub Understanding and an install step that never
installed the reviewed repo's dependencies. See [`CHANGELOG.md`](../CHANGELOG.md).
Do not pin to them. `0.3.0` is the first release meant for use.

`Removed in` is `-` while an input or variable is still read on `main`. When one
is retired, its row gets the version that dropped it, and the row stays so a pin
to an older tag can still be understood.

## Action inputs

Set under `with:` on the `EfeDurmaz16/verit` step.

| Input | Added | Removed in | Purpose |
|---|---|---|---|
| `pr` | 0.1.0 | - | `owner/repo#number` to review. Defaults to the PR that triggered the run |
| `github-token` | 0.1.0 | - | Token to read the PR and post the Check. Needs `checks:write` to post |
| `prove-command` | 0.1.0 | - | Override the detected verification command, as argv |
| `prove-timeout-ms` | 0.1.0 | - | Hard timeout for the verification command. The process group is killed |
| `install-command` | 0.3.0 | - | Install the reviewed repo's dependencies in `GITHUB_WORKSPACE` before prove, e.g. `pnpm install --frozen-lockfile` or `npm ci`. Empty installs nothing |
| `fail-on` | 0.1.0 | - | `failure` or `never`. `failure` maps an inconclusive proof to a failed Check |
| `lane-provider` | 0.1.0 | - | `anthropic` or `openai-compat`. Empty disables the lane and the Check is neutral |
| `lane-tier` | 0.4.0 | - | Review quality tier: `fast`, `balanced`, or `max`. Empty means `balanced` |
| `lane-mode` | 0.5.0 | - | What the lane produces: `understanding`, `review`, or `both`. Empty means `both`. `review` and `both` add a skeptic-verified finding pass. Findings are advisory |
| `lane-model` | 0.1.0 | - | Optional judge override. Pins one exact model whatever the tier. Empty lets the tier pick |
| `lane-api-key` | 0.1.0 | - | API key for `lane-provider`. Falls back to `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| `lane-base-url` | 0.1.0 | - | Base URL for `openai-compat`. Covers OpenAI, Grok, DeepSeek, GLM, local vLLM |
| `lane-harness` | 0.1.0 | - | Legacy: `claude` or `cursor` CLI. Used only when `lane-provider` is empty |
| `anthropic-api-key` | 0.1.0 | - | Legacy: auth for `lane-harness: claude`. Empty disables that harness |
| `dashboard-url` | 0.1.0 | - | Base URL of a verit dashboard. Set with `ingest-token` to upload the run |
| `ingest-token` | 0.1.0 | - | Per-repo ingest token issued by the dashboard. Set with `dashboard-url` |

## Action outputs

Read as `${{ steps.<id>.outputs.<name> }}` on a later step.

| Output | Added | Removed in | Purpose |
|---|---|---|---|
| `conclusion` | 0.3.0 | - | The Check conclusion: `success`, `failure`, or `neutral` |
| `run-id` | 0.3.0 | - | The verit run id, the key for this run's proof artifacts and dashboard page |
| `proof-page-url` | 0.3.0 | - | URL of the uploaded proof page, empty when no dashboard is configured |

## Environment variables

Set on the step, or exported before the CLI runs. The action maps several
inputs onto these. A non-empty input wins over the matching env var.

| Variable | Added | Removed in | Purpose |
|---|---|---|---|
| `GITHUB_TOKEN` | 0.1.0 | - | Optional for public PRs. Needs `checks:write` to post the Check |
| `VERIT_PROVE_CWD` | 0.1.0 | - | Checkout prove runs in. Must be the reviewed repo |
| `VERIT_PROVE_CMD` | 0.1.0 | - | Override the command. A string splits on whitespace, a JSON array is exact argv |
| `VERIT_PROVE_TIMEOUT_MS` | 0.1.0 | - | Hard timeout. The process group is killed |
| `VERIT_FAIL_ON` | 0.1.0 | - | `failure` gates the Check. `never` keeps the neutral default |
| `VERIT_CHECK_DRY_RUN` | 0.1.0 | - | `1` prints the Check body instead of posting it |
| `VERIT_FORCE_NEUTRAL` | 0.1.0 | - | Incident freeze. Any non-empty reason forces every Check to neutral |
| `VERIT_REFUSAL_REASON` | 0.6.0 | - | Why verit declined a privileged event. Set by the action gate, rendered in the neutral Check |
| `VERIT_LANE_PROVIDER` | 0.1.0 | - | `anthropic` or `openai-compat` turns on the built-in HTTP lane |
| `VERIT_LANE_TIER` | 0.4.0 | - | Quality tier: `fast`, `balanced`, or `max`. Default `balanced`. Maps to models, all swappable per tier |
| `VERIT_LANE_MODE` | 0.5.0 | - | What the lane produces: `understanding`, `review`, or `both`. Default `both`. `review` and `both` add a skeptic-verified finding pass. Findings never change the Check conclusion |
| `VERIT_LANE_MODEL` | 0.1.0 | - | Legacy single pin: one model, one pass. Pins the judge for any tier and drops the triage pass. Unset, the tier picks the judge |
| `VERIT_LANE_BASE_URL` | 0.1.0 | - | API base URL override for `openai-compat` |
| `VERIT_LANE_API_KEY` | 0.1.0 | - | Lane API key. Falls back to `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| `VERIT_LANE_MAX_TURNS` | 0.1.0 | - | Lane model-call cap. Default 40 |
| `VERIT_LANE_MAX_TOTAL_TOKENS` | 0.1.0 | - | Lane total token cap. Default 4000000 |
| `VERIT_LANE_TIMEOUT_MS` | 0.1.0 | - | Hard timeout for the lane. Default 900000 |
| `VERIT_LANE_HARNESS` | 0.1.0 | - | Legacy: `claude` or `cursor`, only when no `VERIT_LANE_PROVIDER` is set |
| `ANTHROPIC_API_KEY` | 0.1.0 | - | Auth for the `anthropic` provider, or for `VERIT_LANE_HARNESS=claude` |
| `CURSOR_API_KEY` | 0.1.0 | - | Auth for `VERIT_LANE_HARNESS=cursor` in CI |
| `VERIT_SQLITE_PATH` | 0.1.0 | - | DocumentStore path. Set `""` for in-memory |
| `VERIT_NEO4J_URI` | 0.1.0 | - | `bolt://…`. Memory graph if unset |
| `VERIT_NEO4J_USER` | 0.1.0 | - | Neo4j username when the URI is set |
| `VERIT_NEO4J_PASSWORD` | 0.1.0 | - | Neo4j auth when the URI is set |
| `VERIT_WORKSPACE_DIR` | 0.1.0 | - | Workspace session blobs |
| `VERIT_PI_BIN` | 0.1.0 | - | Path to a Pi binary for the legacy Pi harness |
| `VERIT_DASHBOARD_URL` | 0.1.0 | - | Dashboard base URL. With `VERIT_INGEST_TOKEN` the run is uploaded |
| `VERIT_INGEST_TOKEN` | 0.1.0 | - | Per-repo ingest token from the dashboard |
| `PROOF_PAGE_URL` | 0.1.0 | - | Only to override the computed proof page link |
