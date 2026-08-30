# Security

## Reporting a vulnerability

Email **efe@sardis.sh**. Do not open a public issue.

Include what you did, what happened, and the commit or version you tested.
A proof of concept helps. You will get a first reply within 72 hours.

Please give a reasonable window to ship a fix before publishing. Credit is
given in the release notes unless you ask otherwise.

## What is in scope

verit runs code, so the sharp edges are worth naming.

- **`prove` executing the wrong code.** `prove` runs a repository's own
  verification command. It is meant to run only in a checkout of the repository
  under review and refuses anything else. A way to make it execute in a
  different checkout, or to run a command the target repository did not define,
  is a vulnerability.
- **A green Check nobody earned.** The `verit / behavior-proof` conclusion is
  the exit code of the command that ran, and `neutral` when nothing ran. Any
  path that produces a passing Check without a passing run is a vulnerability,
  not a cosmetic bug.
- **An analysis stage mutating the tree prove measures.** The lane runs
  model-chosen tools, bash included, in an isolated checkout of HEAD, never the
  workspace prove verifies. prove also snapshots that workspace before the lane
  and refuses if HEAD or an uncommitted file moved by the time it runs, so the
  Check goes neutral. A way to make a lane tool change the tree prove measures,
  or to make prove score a tree that shifted during analysis, earns a green
  Check without a real passing run and is in scope.
- **Command injection through pull request content.** Titles, branch names,
  bodies and diffs are attacker controlled on a fork pull request. Commands are
  built as argv, never as shell strings. A way to break out of that is in scope.
- **Dashboard authorization.** Reading a run for a repository you cannot read on
  GitHub, or reusing an ingest token across repositories, is in scope.
- **Token and secret handling.** The signed-in user's GitHub token lives only
  inside the sealed session cookie. Ingest tokens are stored as a sha256 digest.
  Anything that writes either to the database, to a log, or to a proof page is
  in scope.
- **A lane tool reading a secret.** The lane tool subprocess environment is an
  allowlist: PATH, language toolchain vars, npm config, and the keys the
  operator names in `VERIT_LANE_ENV`. No token or key reaches a lane tool, on
  any platform, GitHub Actions included. A way to get `GITHUB_TOKEN`, an ingest
  token, or a model API key into a lane tool is in scope.

## What is not in scope

- Running verit against a repository you control and having it execute that
  repository's test command. That is the product.
- `VERIT_DEV_USER`, which skips GitHub login. It is local only, has no
  default, and is documented as never being set in a deployment.
- Findings in a self-hosted deployment that come from missing configuration,
  for example a dashboard published with no session secret set.

## Workflow advice for repositories that install verit

- Trigger verit with `on: pull_request`, never `pull_request_target`. A
  `pull_request_target` workflow that checks out the pull request head hands
  attacker-controlled code a token with write access. verit never needs that:
  on a fork pull request it expects the read-only token and degrades to a dry
  run on purpose. This is enforced, not only advised: `prove` refuses to run a
  repository's command at all under `pull_request_target`, `workflow_run` or
  `issue_comment`, and the Check goes neutral with the reason. Nothing ran, so
  nothing is claimed.
- Pass the lane key through `lane-api-key` from a repository secret. GitHub
  withholds secrets from fork pull requests, the lane disables itself, and the
  Check is `neutral`. That is the designed behavior, not a failure to fix.

## Self-hosting notes

- Set `VERIT_SESSION_SECRET` to at least 32 random bytes. Rotating it signs
  everyone out, which is the intended lever.
- Never set `VERIT_DEV_USER` anywhere that is reachable from the internet.
- On a fork pull request GitHub withholds secrets and issues a read-only token.
  verit degrades to a dry run rather than failing. That is deliberate.
