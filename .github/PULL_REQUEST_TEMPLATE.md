## What changed and why

<!-- One paragraph each. Name concrete files and behaviors, not "the system". See STYLE.md. -->

## Does this touch prove, or the Check Run conclusion?

`prove` executes code, and the Check Run conclusion must always equal the
real exit code of the command that ran. If this PR touches
`packages/adapters/prove`, `packages/application/src/prove.ts`, or the
conclusion logic in `packages/application/src/check.ts` /
`packages/domain/src/index.ts` (`proofVerdict`), answer this. Otherwise,
write "N/A".

- What is the new failure mode, if any?
- Why does `prove` still refuse to run in the wrong checkout after this change?
- Can this change make the Check Run conclusion something other than the
  real exit code of the command that ran, for any input? Say how you
  checked, not just "no".

## Tests

<!-- New behavior needs a test. What did you add or change, and did you run `pnpm test`? -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] Read [`STYLE.md`](../STYLE.md): no em dash, short sentences, no filler
- [ ] One logical change, Conventional Commits
