# verit security overview

Two pages. What verit is, where the code runs, and what it stores. For a fuller
field-by-field map see [`../data.md`](../data.md). For what verit does not yet
have, see [`not-yet.md`](not-yet.md), which is dated and does not soften
anything.

## What verit does

verit reviews a pull request and posts one Check, `verit / behavior-proof`. The
Check is honest by construction: it runs the repository's own verification
command and reports the true exit code, and it never claims green off an
analysis that did not complete or a diff it only partly read. A change that
cannot be proven goes `neutral`, not green.

## Two ways to run it

**Self-hosted (default, free).** verit runs entirely inside your own CI as a
GitHub Action. No data leaves your infrastructure except the review prompt sent
to the model provider you configure, on your own account. There is no verit
server in this mode.

**Hosted dashboard (optional).** Adds run history and per-repo dashboards. A repo
opts in by setting `VERIT_DASHBOARD_URL` and `VERIT_INGEST_TOKEN` on the Action.
Only then is anything stored off your CI.

## Data flow

1. A pull request opens. The GitHub Action checks out the code in your CI
   runner.
2. The lane sends the diff and context to the model provider and gets back an
   Understanding of the change. The lane's own tools run in an isolated
   checkout, never in the tree that prove is about to measure.
3. `prove` runs the repository's own command (for example `pnpm test`) in the
   real checkout and records the exit code, duration, and log.
4. The Action posts the Check to GitHub.
5. If the hosted dashboard is configured, the run is uploaded: metadata to Neon
   Postgres, the full log to Cloudflare R2. The prove log is redacted for common
   secret shapes before it leaves the runner.

## What executes where

| Component | Runs in | Handles |
|---|---|---|
| GitHub Action, lane, prove | Your CI runner | Your code, the diff, the prove command |
| Model provider | Your configured provider account | The diff and context sent for review |
| Dashboard (Next.js) | Vercel | Sign-in, run pages, the ingest endpoint |
| Postgres | Neon | Run metadata, repo registrations, access cache |
| Object storage | Cloudflare R2 | Stored prove logs |

The code that decides a verdict runs in your CI, not on any verit server. The
dashboard only displays what the Action already decided and uploaded.

## What is stored (hosted mode)

- **Neon Postgres:** the connected repo and the sha256 of its ingest token; one
  row per run with the pull request metadata, the classified domain, the
  verdict, the Understanding, the proof spec, and the log tail; and a cache of
  "may this GitHub user read this repo".
- **Cloudflare R2:** the full prove log per run, keyed `runs/<runId>/<name>`.
- **Never stored in the database:** the raw ingest token (only its hash) and the
  signed-in user's GitHub token (only inside a sealed browser cookie).

## Access control

Every run page and every stored log is gated by `requireRepoAccess`, which
resolves against GitHub: a user sees a run only if GitHub says they may read the
repo it belongs to. A repo a user may not read returns 404, not 403, so the
dashboard never confirms a private repo exists. The answer is cached with a
short TTL and re-checked against GitHub when stale.

## Secret handling

- The session cookie is sealed with AES-256-GCM, which authenticates it and
  keeps the GitHub token out of anything a browser extension or log can read.
- Ingest tokens are stored only as sha256 hashes and compared in constant time.
  A token can be revoked so it stops uploading even though its hash still
  matches.
- Prove logs are passed through a secret-redaction step before upload, masking
  provider tokens, AWS keys, bearer values, connection-string passwords, JWTs,
  and PEM private key blocks. This is best-effort, not a guarantee.

## Data lifecycle

- Prove logs and the stored log tail are deleted 30 days after upload by a
  scheduled retention job.
- Run rows are deleted 12 months after upload.
- A repo's entire run history and its logs can be erased on demand with
  `DELETE /api/repos/{owner}/{repo}`.

## Tenancy and isolation

The dashboard is multi-tenant at the row level: every query is scoped by repo,
and every read is gated by GitHub read access to that repo. There is no shared
view across orgs. The lane's tools run in a throwaway checkout isolated from the
tree prove measures, so a hostile change cannot doctor its own proof.

## Reporting a vulnerability

Email efe@sardis.sh. Do not open a public issue for a security report. See
[`../../SECURITY.md`](../../SECURITY.md).
