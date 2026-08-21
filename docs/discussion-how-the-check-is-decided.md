<!--
Staging file for a pinned GitHub Discussion. Efe posts this by hand (the
account posting issues/PRs is suspended, this repo cannot open it via API).
Post under Discussions > General, or a new "How verit works" category, and
pin it.
-->

# How the verit / behavior-proof Check is decided

Short version: the Check conclusion is the exit code of the command that
ran. Nothing else decides it. This post explains the three cases and why
each one is what it is.

## The three conclusions

GitHub Check Runs support a `conclusion` field. verit only ever sets one of
three values:

- **`success`**: the reviewed repository's own verification command ran and
  exited 0.
- **`failure`**: the command ran and exited non-zero.
- **`neutral`**: nothing ran, or what ran does not count as proof.

There is no fourth option where verit invents a conclusion from a model's
opinion. If `prove` did not execute, the Check cannot be green. That rule is
in `packages/domain/src/index.ts`, in a function called `proofVerdict`:

```ts
export const proofVerdict = (
  outcome: { readonly exitCode: number; readonly refused?: string } | null | undefined,
): "success" | "failure" | "neutral" =>
  outcome == null || outcome.refused != null
    ? "neutral"
    : outcome.exitCode === 0
      ? "success"
      : "failure";
```

One function, three lines of real logic. The Check Run and the dashboard row
both read the conclusion from here, so a run cannot show green on one
surface and neutral on the other.

## Case 1: analysis did not complete

verit's first stage is an "Understanding": a model reads the diff and
writes down what changed, why, and how. If that stage fails or times out,
there is no Understanding. The Check goes `neutral` regardless of what the
tests did. A passing test suite next to a failed analysis stage is still
`neutral`, because the Check is reporting on the pull request, not
performing an isolated CI run.

## Case 2: analysis completed but nothing was proved

An Understanding without a `prove` run is also `neutral`. Maybe `prove` was
never configured. Maybe the working tree changed between when it snapshotted
and when it tried to run, and it refused rather than measure a moving
target (see the next section). Either way: no execution, no green check.

## Case 3: prove ran, and the exit code decides

When `prove` actually runs the repository's own verification command, the
Check conclusion is the exit code. Full stop, with one adjustment: coverage.

### The coverage cap

Large diffs get sliced before they reach the model, because there is a
character budget per lane call (`DIFF_BUDGET_CHARS`, 120,000 net chars after
move detection). If the diff is bigger than that, the analysis only saw part
of it. In that case, even a passing `prove` run caps the conclusion at
`neutral`, never `success`:

```ts
const uncapped = u === null ? "neutral" : proofVerdict(outcome);
// partial analysis never turns green, however loudly the tests passed
const conclusion = uncapped === "success" && coverage < 100 ? "neutral" : uncapped;
```

The tests passing and the analysis being complete are different claims. A
green check asserts both. If the analysis only covered part of the diff,
verit says so in the Check body instead of rounding up.

## The fork degradation case

A pull request from a fork does not carry secrets: GitHub withholds them by
policy, on purpose, because a fork PR is attacker-controlled code and
handing it a real token would be a way to exfiltrate one. verit is built
around that, not against it:

- With no lane API key reachable, the Action disables the lane before it
  starts. No Understanding is produced. The Check is `neutral`.
- With a read-only `GITHUB_TOKEN` (which is what a fork PR gets), the Check
  cannot even be posted, since posting a Check Run needs `checks:write`.
  verit prints the Check body to the job log instead (a "dry run") and does
  not fail the job over the announcement.

Both are deliberate. A fork PR degrading to "nothing ran, nothing claimed"
is the safe failure mode. The alternative, a workflow that hands a fork PR a
writable token so its Check can post, is the `pull_request_target` mistake,
and verit is built specifically to avoid needing that.

## Why this is worth a whole post

The one rule this repository cannot break is in `CONTRIBUTING.md`, word for
word: "Never make the Check Run conclusion anything other than the real exit
code of the command that ran. A green check that nothing earned is the one
bug this project cannot ship." Everything above is that rule traced through
the actual code path, so a reader can verify it instead of taking the claim
on faith. If you find a path that produces `success` without a passing
`prove` run, that is a vulnerability. See `SECURITY.md`.

Questions and corrections welcome below.
