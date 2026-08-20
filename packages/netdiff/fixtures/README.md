# netdiff field-eval fixtures

Real PR diffs, frozen. The field-eval harness (`packages/netdiff/scripts/field-eval.ts`)
runs the whole pipeline over these, and `src/fixtures.test.ts` runs the truthfulness
properties over them in CI. They never change, so the numbers stay comparable.

Fetched once as unauthenticated public `.diff` URLs. Do not regenerate from a live
fetch in CI: CI reads these committed bytes so the run is deterministic.

| File | PR shape / profile | Why it is here |
|---|---|---|
| `verit-rename.diff` | mechanical-rename | The killer case: 550 in-place edits collapse to 41 aggregated focus lines across 119 files. |
| `effect-refactor.diff` | ordinary-feature | A real logic refactor: new code plus in-place token edits, the everyday review shape. |
| `vscode-move.diff` | file-move | A cross-directory file move where the only real change is three import paths. |
| `vite-deps.diff` | deps-bump | Version bumps in a manifest and a lockfile: same token bump repeated across files. |
| `vite-docs.diff` | small-feature | A one-line documentation edit: the smallest real change, a floor for the harness. |

`paykit283.diff` (275 KB, 51 files, 9 pure moves) was left out on size. The move-heavy
profile is covered instead by the synthetic 5k-line 80-percent-move patch the harness
generates in memory (`syntheticMovePatch` in `src/eval.ts`), which needs no committed blob.
