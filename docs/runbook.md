# Ops runbook

One page per incident. Each names the exact command and the state a user sees
while it runs. The reflex for anything touching a green claim: freeze first,
diagnose second. A neutral check that should be green is an annoyance. A green
check that should be neutral is the failure this whole product exists to
prevent.

Commands assume the dashboard env (`DATABASE_URL`, and the R2 and session
variables) is loaded, and that `gh` is authenticated for the repo.

---

## 1. Reported false green

A run posted a green `verit / behavior-proof` check for a change that did not
actually prove its behavior.

### Freeze (target: within minutes)

Force every affected check to no-claim before touching the cause. Set the freeze
reason as a repository variable, so the next run picks it up with no code change:

```bash
gh variable set VERIT_FORCE_NEUTRAL \
  --repo owner/name \
  --body "INC-<id>: suspected false green on <path>, frozen while investigating"
```

**User-visible state:** every new run on that repo concludes `neutral`, titled
`Frozen to no-claim: INC-<id> ...`. The proof result still shows in the body,
but no run claims green. This can only downgrade a claim, so it is always safe
to leave on. The mechanism is `forceNeutral` in
`packages/application/src/check.ts`, wired from the env in
`packages/cli/src/main.ts`.

### Reproduce from the run id

Every check body ends with `verit run <runId>`, and the run id carries the trace
id. Re-run the exact pipeline path locally:

```bash
PR_SPEC="owner/name#<pr>" \
GITHUB_TOKEN="$(gh auth token)" \
VERIT_PROVE_CWD="$PWD" \
VERIT_CHECK_DRY_RUN=1 \
pnpm cli dogfood "owner/name#<pr>"
```

**User-visible state:** none. This is a dry run, it posts nothing.

### Ship the patch that forces the path to no-claim

Fix the root cause so the affected path can no longer produce a false green.
Usually the detected command did not exercise the changed behavior: correct the
command (`VERIT_PROVE_CMD`) or the detection in `packages/adapters/prove`. Until
the fix merges, the freeze from step one is already holding the line. Once the
fix is on the default branch and a fresh run proves it neutral-or-honest, lift
the freeze:

```bash
gh variable delete VERIT_FORCE_NEUTRAL --repo owner/name
```

**User-visible state:** runs resume real conclusions. A path that cannot be
honestly proven now goes `neutral` on its own, not green.

### Post-mortem

Write what produced the false green, why prove reported exit 0 without covering
the behavior, and the detection change that closes it. Link the run id and the
freeze/lift timestamps.

### Drill, run 2026-08-21 against a fixture false-green report

Timed, single operator, to prove the loop fits inside 24h.

| Step | Command | Elapsed |
|---|---|---|
| Freeze | `gh variable set VERIT_FORCE_NEUTRAL ...` | 0h00 |
| Reproduce from run id | `pnpm cli dogfood owner/name#<pr>` (dry run) | 0h06 |
| Root cause found | detected `test` script skipped the changed module | 0h35 |
| Patch shipped | corrected `VERIT_PROVE_CMD`, fresh run concludes neutral | 3h10 |
| Freeze lifted | `gh variable delete VERIT_FORCE_NEUTRAL` | 3h20 |
| Post-mortem written | linked to INC id | 4h00 |

Result: shipped no-claim patch at 3h10, well inside the 24h bar. The freeze held
from 0h00, so no false green was reachable for the whole window.

---

## 2. Neon or R2 down

Postgres (Neon) or object storage (R2) is unreachable.

**No command is needed on the Action side.** The upload path is built to fail
soft. `uploadRun` in `packages/cli/src/upload.ts` never throws: a dashboard that
is down, slow, or misconfigured is reported on stderr and the job continues.

**User-visible state:**

- The Action still runs the review and still posts the Check. The check body
  falls back to `_This run has no hosted proof page._` when no page was
  published.
- The run upload fails and is logged as `dashboard upload failed: ...` on the
  job's stderr. The job stays green. No run is lost to a failed CI job, only to
  a store that was down.
- The dashboard itself returns 503 on `/r/...` pages while Neon or R2 is down. A
  page view is a read against the store, and there is nothing to serve.

Recovery: when the store returns, re-running the Action re-uploads the run.
`saveRun` upserts on the run id, so a re-upload lands on the same row and is not
a duplicate.

---

## 3. Session secret rotation

Rotate `VERIT_SESSION_SECRET`, the key that seals the session cookie.

```bash
# 1. mint a new secret
openssl rand -base64 48
# 2. set it in Vercel (all environments), then redeploy
vercel env rm VERIT_SESSION_SECRET production
vercel env add VERIT_SESSION_SECRET production   # paste the new value
vercel deploy --prod
```

**User-visible state:** every existing session cookie fails to open under the
new key, so every signed-in user is signed out and lands back at the GitHub
sign-in. No data is touched. Ingest uploads are unaffected: they authenticate
with the per-repo token, not the session. See `apps/dashboard/lib/crypto.ts`,
where `open` returns null for anything the current key did not seal.

---

## 4. Ingest token revocation

A repo's ingest token leaked, or a repo must stop uploading now.

```bash
pnpm --filter @verit/dashboard revoke-repo owner/name
```

**User-visible state:** the repo stays connected and its history stays readable,
but any upload with the current token is rejected with `401 unknown repo or bad
ingest token`, the same answer a wrong token gets. The review still runs and the
Check still posts: the upload failure is swallowed and logged, exactly as in
scenario 2. The check body degrades to no proof-page link.

Reconnect with a fresh token when ready. `register-repo` reissues and clears the
revocation in one step:

```bash
pnpm --filter @verit/dashboard register-repo owner/name
# put the printed VERIT_INGEST_TOKEN in the repo's GitHub secrets
gh secret set VERIT_INGEST_TOKEN --repo owner/name --body "vrt_..."
```

The code: `revoked_at` on `repos`, checked in `authorizeIngest`
(`apps/dashboard/lib/ingest.ts`); the scripts are
`apps/dashboard/scripts/revoke-repo.ts` and `register-repo.ts`.

---

## 5. Lane provider outage or 429 storm

The review model provider is down or rate-limiting.

**No command is needed to stay safe.** A lane that does not complete produces no
Understanding, and a run with no Understanding concludes `neutral`, never green
(`behaviorProofCheck` in `packages/application/src/check.ts`). prove still runs
the repo's own command and reports its real exit code inside the body.

**User-visible state:** checks go `neutral`, titled `Analysis did not complete`,
not red. No change is ever claimed green off a failed analysis.

To restore analysis faster than the provider does, point the lane at a fallback
by changing repo variables, no code change:

```bash
# switch provider or model
gh variable set VERIT_LANE_PROVIDER --repo owner/name --body "openai-compat"
gh variable set VERIT_LANE_MODEL --repo owner/name --body "<model-id>"
gh variable set VERIT_LANE_BASE_URL --repo owner/name --body "https://<fallback>/v1"
# or turn the lane off entirely: unset VERIT_LANE_PROVIDER. Runs then go
# neutral by design until the provider is back.
```

**User-visible state after the switch:** runs produce an Understanding again and
resume honest conclusions. Nothing turns green that a failed analysis would have
left neutral.
