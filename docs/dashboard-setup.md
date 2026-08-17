# Dashboard setup

The hosted surface: teams sign in with GitHub, see run history per repo, and open a
run's proof page. The Check Run posted by the Action links straight at a run.

Two halves. Run it locally first, then do the hosted checklist once.

## Run it locally

Nothing here needs a cloud account.

```bash
docker compose up -d postgres          # host port 5433, see docker-compose.yml
cd apps/dashboard
export DATABASE_URL="postgres://verit:verit-dev@localhost:5433/verit"
export VERIT_SESSION_SECRET="$(openssl rand -base64 48)"
pnpm migrate                           # idempotent, safe to re-run
pnpm register-repo EfeDurmaz16/verit # prints the ingest token once
pnpm dev                               # http://localhost:3001
```

`register-repo` prints `VERIT_INGEST_TOKEN=...` once. Only its sha256 digest is
stored, so a lost token is reissued by running the command again, never recovered.

To skip the GitHub login while developing, set `VERIT_DEV_USER` to a login:

```bash
VERIT_DEV_USER=EfeDurmaz16 pnpm dev
```

This is opt-in and has no default. With the variable unset the dashboard always
asks GitHub who you are. A dev session carries no GitHub token, which is also why
it is the one path that skips the per-repo access check. Never set it in a
deployed environment.

Then run the pipeline against it:

```bash
PR_SPEC="EfeDurmaz16/verit#1" \
GITHUB_TOKEN="$(gh auth token)" \
VERIT_PROVE_CWD="$PWD" \
VERIT_CHECK_DRY_RUN=1 \
VERIT_DASHBOARD_URL="http://localhost:3001" \
VERIT_INGEST_TOKEN="vrt_..." \
pnpm cli dogfood "EfeDurmaz16/verit#1"
```

The run appears at `/r/EfeDurmaz16/verit`, and its proof page at
`/r/EfeDurmaz16/verit/runs/{runId}`, which is the URL printed as
`proofPageUrl` and linked from the Check body.

## Environment variables

| Variable | Where | What it does |
|---|---|---|
| `DATABASE_URL` | dashboard | Postgres connection string. Neon in production |
| `VERIT_SESSION_SECRET` | dashboard | At least 32 chars. Seals the session cookie. Rotating it signs everyone out |
| `GITHUB_CLIENT_ID` | dashboard | OAuth app client id |
| `GITHUB_CLIENT_SECRET` | dashboard | OAuth app client secret |
| `VERIT_ACCESS_TTL_SECONDS` | dashboard | How long a cached "may read" answer is trusted. Default 600 |
| `VERIT_BLOB_DIR` | dashboard | Where the filesystem object store writes. Local only, ignored once S3 is configured |
| `VERIT_S3_ENDPOINT` | dashboard | S3 endpoint origin, no bucket. R2: `https://<account-id>.r2.cloudflarestorage.com` |
| `VERIT_S3_BUCKET` | dashboard | Bucket name, e.g. `verit-proofs` |
| `VERIT_S3_ACCESS_KEY_ID` | dashboard | R2 API token access key id |
| `VERIT_S3_SECRET_ACCESS_KEY` | dashboard | R2 API token secret access key |
| `VERIT_S3_REGION` | dashboard | Optional. Defaults to `auto`, which is what R2 wants. MinIO wants a real region |
| `VERIT_DEV_USER` | dashboard | Local only. Skips login as that GitHub login. Never set in a deployment |
| `VERIT_DASHBOARD_URL` | Action | Base URL of the dashboard. Unset means no upload |
| `VERIT_INGEST_TOKEN` | Action | Per-repo token from `register-repo`. Unset means no upload |
| `PROOF_PAGE_URL` | Action | Only to override the computed proof page link |

## Hosted checklist

Do these once, in this order.

### 1. Neon Postgres

1. Create a Neon project. Pick the region closest to the Vercel deployment.
2. Copy the pooled connection string. It ends with `?sslmode=require`.
3. Keep the major version in step with `docker-compose.yml`, which pins
   postgres 17.
4. Apply the schema against it:
   ```bash
   DATABASE_URL="postgres://...neon.tech/verit?sslmode=require" \
     pnpm --filter @verit/dashboard migrate
   ```
5. Register each repo the same way, once per repo:
   ```bash
   DATABASE_URL="..." pnpm --filter @verit/dashboard register-repo owner/name
   ```
   Put the printed token in that repo's GitHub secrets as
   `VERIT_INGEST_TOKEN`, and set the repository variable
   `VERIT_DASHBOARD_URL` to the dashboard's URL.

### 2. GitHub OAuth app

1. GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.
2. Homepage URL: the dashboard's URL.
3. Authorization callback URL: `https://<dashboard>/api/auth/callback`.
   It must match exactly, including the scheme.
4. Generate a client secret. Copy both values into Vercel.
5. Scopes are requested by the app, not configured here. It asks for
   `read:user read:org repo`. `repo` is what lets the dashboard ask GitHub
   whether a signed-in user may read a private repo. It is a coarse grant.
   A GitHub App with per-repo installation would be finer and is the upgrade
   path; it is not in phase 1.

For local development make a second OAuth app with callback
`http://localhost:3001/api/auth/callback`. GitHub allows only one callback per
app, so do not reuse the production one.

### 3. Cloudflare R2

Wired. `packages/adapters/s3-blob` implements `ObjectStorePort` against the S3
API, and `apps/dashboard/lib/objects.ts` picks it whenever the four S3 variables
are set. With none of them set the dashboard keeps writing to the filesystem, so
local development needs no change. With only some of them set it refuses to
start the request rather than falling back, because on Vercel a filesystem
fallback loses every log while looking like it worked.

1. Cloudflare, R2, create a bucket, e.g. `verit-proofs`.
2. Create an R2 API token scoped to that bucket, read and write.
3. Note the account id, access key id and secret access key. The S3 endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`, with no bucket in it: the
   adapter addresses objects path style, as `<endpoint>/<bucket>/<key>`. A
   bucket created in a jurisdiction has its own endpoint, `<account-id>.eu.` or
   `<account-id>.fedramp.`, and can only be reached through it.
4. Set these in Vercel:
   ```
   VERIT_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   VERIT_S3_BUCKET=verit-proofs
   VERIT_S3_ACCESS_KEY_ID=<access key id>
   VERIT_S3_SECRET_ACCESS_KEY=<secret access key>
   ```
   `VERIT_S3_REGION` is optional and defaults to `auto`, which is the region
   R2 expects. Leave it unset for R2.

To exercise the same code path locally, run MinIO instead of R2:

```bash
docker compose up -d minio    # S3 on :9000, console on :9001
cd apps/dashboard
VERIT_S3_ENDPOINT=http://localhost:9000 \
VERIT_S3_BUCKET=verit-proofs \
VERIT_S3_ACCESS_KEY_ID=verit \
VERIT_S3_SECRET_ACCESS_KEY=verit-dev-secret \
VERIT_S3_REGION=us-east-1 \
pnpm dev
```

MinIO checks the region in the signature, which is why it needs
`VERIT_S3_REGION` and R2 does not. The adapter's own integration tests run
against the same container when `VERIT_S3_TEST_ENDPOINT` is set, and are
skipped when it is not:

```bash
VERIT_S3_TEST_ENDPOINT=http://localhost:9000 \
VERIT_S3_TEST_BUCKET=verit-proofs \
VERIT_S3_TEST_ACCESS_KEY_ID=verit \
VERIT_S3_TEST_SECRET_ACCESS_KEY=verit-dev-secret \
pnpm --filter @verit/adapter-s3-blob test
```

### 4. Vercel

1. Import the repo. Set the root directory to `apps/dashboard`.
2. Build command and install command: leave the defaults. The monorepo builds
   through pnpm workspaces.
3. Environment variables, all environments unless noted:
   - `DATABASE_URL`, the Neon pooled string
   - `VERIT_SESSION_SECRET`, from `openssl rand -base64 48`
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
   - `VERIT_S3_ENDPOINT`, `VERIT_S3_BUCKET`, `VERIT_S3_ACCESS_KEY_ID`,
     `VERIT_S3_SECRET_ACCESS_KEY`, from the R2 step
   - `VERIT_ACCESS_TTL_SECONDS`, optional
   - Do NOT set `VERIT_DEV_USER`
4. Deploy, then update the OAuth app's callback URL to the real domain if you
   created it against a preview URL.
5. Sign in once and confirm you land on your organization list.

### 5. Wire the Action

In each connected repo:

- Repository variable `VERIT_DASHBOARD_URL` = the dashboard URL.
- Repository secret `VERIT_INGEST_TOKEN` = the token from `register-repo`.

`.github/workflows/dogfood.yml` already passes both through. With either unset
the job runs exactly as before: no upload, no proof page link, same Check.

Fork pull requests do not receive secrets, so a fork PR uploads nothing. That is
by design, the same way its Check post degrades to a dry run.

## What is stored

- `repos`: the connected repo and the sha256 of its ingest token.
- `runs`: one row per uploaded run, with the Understanding and the proof spec as
  jsonb, the prove verdict, and the log tail.
- `repo_access`: the cached answer to "may this user read this repo", with the
  time it was checked.
- Object store: the full prove log, keyed `runs/<runId>/prove.log`. R2 when the
  S3 variables are set, the filesystem otherwise.

The user's GitHub token lives only inside the sealed session cookie. It is never
written to the database.
