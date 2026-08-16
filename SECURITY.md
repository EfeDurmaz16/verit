# Security

## Reporting a vulnerability

Email **efe@sardis.sh**. Do not open a public issue.

Include what you did, what happened, and the commit or version you tested.
A proof of concept helps. You will get a first reply within 72 hours.

Please give a reasonable window to ship a fix before publishing. Credit is
given in the release notes unless you ask otherwise.

## What is in scope

cyclops runs code, so the sharp edges are worth naming.

- **`prove` executing the wrong code.** `prove` runs a repository's own
  verification command. It is meant to run only in a checkout of the repository
  under review and refuses anything else. A way to make it execute in a
  different checkout, or to run a command the target repository did not define,
  is a vulnerability.
- **A green Check nobody earned.** The `cyclops / behavior-proof` conclusion is
  the exit code of the command that ran, and `neutral` when nothing ran. Any
  path that produces a passing Check without a passing run is a vulnerability,
  not a cosmetic bug.
- **Command injection through pull request content.** Titles, branch names,
  bodies and diffs are attacker controlled on a fork pull request. Commands are
  built as argv, never as shell strings. A way to break out of that is in scope.
- **Dashboard authorization.** Reading a run for a repository you cannot read on
  GitHub, or reusing an ingest token across repositories, is in scope.
- **Token and secret handling.** The signed-in user's GitHub token lives only
  inside the sealed session cookie. Ingest tokens are stored as a sha256 digest.
  Anything that writes either to the database, to a log, or to a proof page is
  in scope.

## What is not in scope

- Running cyclops against a repository you control and having it execute that
  repository's test command. That is the product.
- `CYCLOPS_DEV_USER`, which skips GitHub login. It is local only, has no
  default, and is documented as never being set in a deployment.
- Findings in a self-hosted deployment that come from missing configuration,
  for example a dashboard published with no session secret set.

## Self-hosting notes

- Set `CYCLOPS_SESSION_SECRET` to at least 32 random bytes. Rotating it signs
  everyone out, which is the intended lever.
- Never set `CYCLOPS_DEV_USER` anywhere that is reachable from the internet.
- On a fork pull request GitHub withholds secrets and issues a read-only token.
  cyclops degrades to a dry run rather than failing. That is deliberate.
