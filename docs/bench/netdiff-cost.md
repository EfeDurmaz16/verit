# netdiff cost reduction

Measured, not estimated. Every number here comes from one command over the
committed fixtures plus the in-memory synthetic move patch:

    pnpm --filter @verit/netdiff bench:md > docs/bench/netdiff-cost.md

Regenerate it after any change to the netdiff pipeline or the fixtures. Do not
hand-edit this file: the harness overwrites it.

## What the columns mean

- gross chars: the raw unified diff, what a naive prompt would carry.
- net/section chars: the rendered `diffSection` prompt netdiff delivers, moves
  pre-factored, mechanical repetition aggregated, genuinely new code kept in full.
- reduction: how much smaller the delivered prompt is than the raw diff. It goes
  negative on small ordinary diffs, where netdiff adds move-analysis prose and
  per-change focus markers to a diff that was already cheap. The win is on the
  expensive shapes: move-heavy and mechanical-rename.
- focus lines: in-place edits to rendered focus lines. This is the attention win
  the char count does not show: 550 scattered edits named as 41 lines is the
  reviewer reading one pattern, not re-reading 550 near-identical changes.
- ms: wall time for the full pipeline on this machine, single run.

## Reference baselines (Aug 2026)

- Synthetic 5k-line 80-percent-move patch: 252 KB gross drops to about 36 KB net,
  around 85 percent smaller. The row below reproduces it live.
- The cyclops-to-verit rename collapses 550 in-place edits to 41 aggregated focus
  lines across 119 files. The `verit-rename.diff` row reproduces it live.

## Measured table

| profile | fixture | files | gross chars | net/section chars | reduction | focus lines | ms |
|---|---|---|---|---|---|---|---|
| move-heavy (synthetic) | syntheticMovePatch | 22 | 252,176 | 36,798 | 85% | 0 to 0 | 15.0 |
| ordinary-feature | effect-refactor.diff | 2 | 14,198 | 16,644 | -17% | 24 to 19 | 5.1 |
| mechanical-rename | verit-rename.diff | 119 | 166,225 | 126,149 | 24% | 550 to 41 | 35.6 |
| deps-bump | vite-deps.diff | 2 | 2,589 | 2,818 | -9% | 3 to 1 | 0.3 |
| small-feature | vite-docs.diff | 3 | 2,496 | 1,949 | 22% | 1 to 1 | 0.2 |
| file-move | vscode-move.diff | 3 | 2,952 | 2,719 | 8% | 3 to 3 | 0.3 |

## Reading it

Move-heavy and mechanical-rename are where review cost actually lives, and they
are where netdiff cuts. A 250 KB reorganization that is 80 percent moved code
becomes a 36 KB prompt. A 119-file rename stops being 550 changes to read and
becomes 41 patterns to confirm. On an ordinary 14 KB feature diff netdiff spends
a few thousand extra chars to mark exactly which tokens changed inside each
replacement, which is the cheap end of the trade and the right place to spend.

