# Data and trust posture

What verit stores, where each field lives, how long it is kept, and who can read
it. Grounded in `apps/dashboard/lib/schema.ts` (the whole schema) and the upload
path in `apps/dashboard/app/api/ingest/route.ts`.

verit stores data only when a repo is connected to the hosted dashboard, that
is when `VERIT_DASHBOARD_URL` and `VERIT_INGEST_TOKEN` are set on the Action. A
repo that runs the Action without those variables uploads nothing: the review
runs, the Check posts, and no row is written anywhere.

## Where data lives

- **Neon Postgres**: the `repos`, `runs`, and `repo_access` tables.
- **Cloudflare R2**: one object per uploaded log, keyed `runs/<runId>/<name>`.
  When R2 is not configured the same objects go to the local filesystem instead
  (development only, see `apps/dashboard/lib/objects.ts`).
- **The browser session cookie**: the signed-in user's GitHub login and GitHub
  token, sealed with AES-256-GCM. This never touches the database. See
  `apps/dashboard/lib/crypto.ts` and `session.ts`.

## Every stored field

### `repos` table (Neon)

One row per connected repo.

| Field | What it is | Who can read it |
|---|---|---|
| `id` | `owner/name` slug, the primary key | Anyone who may read the repo |
| `owner` | Org or user login | Anyone who may read the repo |
| `name` | Repo name | Anyone who may read the repo |
| `ingest_token_hash` | sha256 of the ingest token. The token itself is never stored | Nobody. Never selected into a page or an API response |
| `created_at` | When the repo was connected | Internal only |
| `revoked_at` | Set when the token is revoked, else null | Internal only |

The ingest token is shown once by `register-repo` and never again. Only its
sha256 digest is kept, so a lost token is reissued, never recovered.

### `runs` table (Neon)

One row per uploaded run. Written by `saveRun` in `apps/dashboard/lib/runs.ts`,
upserted on `id` so a retried upload lands on the same row.

| Field | What it is |
|---|---|
| `id` | Run id from the pipeline, carries the run's own trace id |
| `repo_id` | Foreign key to `repos`, cascade on delete |
| `pr_number`, `pr_title`, `pr_url`, `pr_author` | The reviewed pull request as GitHub reported it |
| `head_sha` | Commit the run measured |
| `domain`, `focus` | The change's classified domain |
| `verdict` | `success`, `failure`, or `neutral` |
| `proof_status` | `pass`, `fail`, or `none` |
| `proof_command`, `proof_source` | The verification command that ran and where it came from |
| `exit_code`, `duration_ms`, `timed_out` | The command's real result |
| `log_tail` | The tail of the prove log, redacted before upload (see below) |
| `log_keys` | The R2 keys of this run's stored logs |
| `understanding` | The model's Understanding of the change, as jsonb |
| `proof_spec` | The proof page render spec, as jsonb |
| `created_at` | When the run ran |
| `uploaded_at` | When the dashboard received it. The retention clock |

Every `runs` row is readable only by a GitHub user who may read the repo it
belongs to. The check is `requireRepoAccess` in `apps/dashboard/lib/guard.ts`,
which resolves against GitHub and caches the answer in `repo_access`.

### `repo_access` table (Neon)

The cached answer to "may this GitHub user read this repo". Not a grant of its
own: an entry past its TTL is re-checked against GitHub before it is trusted
(`apps/dashboard/lib/access.ts`).

| Field | What it is |
|---|---|
| `user_login` | The signed-in GitHub login |
| `repo_id` | The repo the answer is about |
| `can_read` | The cached yes or no |
| `checked_at` | When GitHub was last asked. TTL is `VERIT_ACCESS_TTL_SECONDS`, default 600s |

### Object store (Cloudflare R2)

| Object | What it is | Who can read it |
|---|---|---|
| `runs/<runId>/prove.log` | The full prove log for a run | Served only through `/r/{owner}/{repo}/runs/{runId}/logs/{name}`, behind the same `requireRepoAccess` check as the run page |

The log body is redacted before it leaves the runner. See the next section.

### Session cookie (browser only)

The signed-in user's GitHub token lives only inside the sealed session cookie,
never in the database. GCM authenticates the cookie and keeps the token out of
anything a browser extension or a log can read.

## Secret redaction before upload

Before a run is uploaded, `redactSecrets` (`packages/application/src/redact.ts`)
masks common secret shapes in the prove log tail and the full log body:
provider tokens (GitHub, verit ingest, OpenAI, Slack), AWS access keys, bearer
header values, connection-string passwords, JWTs, PEM private key blocks, and
any `*secret*` / `*token*` / `*password*` / `*api_key*` assignment. It runs in
`buildUpload` (`packages/cli/src/upload.ts`) over the `prove.logTail`, the log
blob, and the proof-ref logs on the Understanding, so a leaked secret never
reaches Neon or R2. It is a best-effort denylist, not a guarantee.

## Retention

Retention is enforced as a scheduled deletion, not a promise. The job is
`apps/dashboard/lib/retention.ts`, run by `apps/dashboard/scripts/retention.ts`
(`pnpm --filter @verit/dashboard retention`) on a schedule.

| Data | Window | What happens |
|---|---|---|
| Prove logs (R2 blobs) and `log_tail` | 30 days after `uploaded_at` | Blobs deleted from R2, `log_keys` and `log_tail` cleared. The run's metadata row stays |
| `runs` rows | 12 months after `uploaded_at` | The whole row is deleted |
| `repo_access` rows | No timer | A short-lived cache, re-checked against GitHub past its TTL |
| `repos` rows | No timer | Kept while the repo is connected. Removed by erasing the repo (below) |

Windows are configurable with `VERIT_BLOB_TTL_DAYS` and `VERIT_ROW_TTL_DAYS`.
The blob pass runs before the row pass and covers every run past 30 days, so a
row reaching the 12-month cut has no blobs left to orphan.

## On-demand erasure

`DELETE /api/repos/{owner}/{repo}` erases a repo's run history now: every `runs`
row and every R2 blob for that repo. It is authorized exactly like reading a
run, through `requireRepoAccess`, and the repo registration itself is kept so
the repo can keep ingesting. The code is `deleteRepoData` in
`apps/dashboard/lib/repo-delete.ts`.

## Ingest token revocation

`revoke-repo` (`pnpm --filter @verit/dashboard revoke-repo owner/name`) marks a
repo's token revoked. After that, an upload with the current token is rejected
with the same 401 a wrong token gets, even though the hash still matches. This
is distinct from reissue: `register-repo` mints a fresh token and clears the
revocation in one step.

## Subprocessors

The hosted dashboard runs on these third parties. Each sees only what its role
needs.

| Subprocessor | Role | What it can see |
|---|---|---|
| GitHub | Source of the code, the pull requests, and the read-access answer | The repos and pull requests verit reviews |
| Neon | Postgres host | The `repos`, `runs`, and `repo_access` tables |
| Vercel | Dashboard hosting | Request traffic to the dashboard |
| Cloudflare R2 | Object storage | The stored prove logs |
| The lane model provider | Runs the review model | The diff and context sent to the model. Anthropic by default, or whatever `VERIT_LANE_PROVIDER` names |

Self-hosting removes every subprocessor except the model provider, and even that
is your own account and your choice of provider.
