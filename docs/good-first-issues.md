<!--
Staging file, not a tracker. Efe opens each of these as a real GitHub issue
by hand (the account that would open them is suspended right now). Each
entry names the exact file:line it comes from so opening the issue is a
copy-paste, and so a contributor can verify the claim before starting.

No literal TODO/FIXME exist in this codebase (checked: grep -rniE
"TODO|FIXME|XXX:|HACK:" across the whole repo, zero hits). Every item below
is a real, small, honestly-scoped gap found by reading the code, not a
marked comment.
-->

# Good first issues

## 1. `pnpm cli` help text is missing three documented env vars

`packages/cli/src/main.ts:42-73` is the `help` string printed by `verit`
with no arguments or an unknown command. It documents most env vars the CLI
reads, but three are missing even though README's Configuration table
(`README.md:277`, `:290-291`) documents them and the code reads them:

- `VERIT_CHECK_DRY_RUN` (`packages/cli/src/main.ts:282`)
- `VERIT_NEO4J_USER`
- `VERIT_NEO4J_PASSWORD`

Add one line per variable to the `help` string, next to the existing
`VERIT_NEO4J_URI` line and the Check-posting section, matching the style of
the surrounding lines (name, default, one sentence). No code path changes,
just the string.

## 2. Go top-level `var`/`const` declarations are not extracted as symbols

`packages/adapters/treesitter/src/index.ts:40-66` is `DECL_KIND`, the map
from tree-sitter node type to symbol kind. For Go it only maps
`method_declaration` and `type_spec` (line 64-65). A top-level `func` is
caught separately as `function_declaration` (shared with JS, line 42). But a
top-level Go `var` or `const` block never produces a symbol at all: there is
no handling for Go's `var_declaration`/`const_declaration` nodes anywhere in
`collect()` (`index.ts:102-156`), unlike Rust's `const_item`/`static_item`
which are in `DECL_KIND` already.

Confirm this with the existing fixture: `packages/adapters/treesitter/fixtures/sample.go`
has no top-level var or const today, and the test at
`packages/adapters/treesitter/src/treesitter.test.ts:71-77` does not check
for one. Add a `var`/`const` to the fixture, add symbol handling for Go's
declaration nodes (inspect the tree shape with `tree-sitter-go`'s own test
fixtures or a quick script; the node is `var_declaration` containing
`var_spec` children with a `name` field), and extend the test to assert the
new symbol appears.

## 3. `parsePrSpec`'s error message drops the input that failed to parse

`packages/cli/src/main.ts:97-100`:

```ts
const parsePrSpec = (spec: string): { owner: string; repo: string; number: number } => {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(spec);
  if (!m) throw new Error("usage: owner/repo#123");
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
```

When a user passes a malformed spec, the thrown error shows the expected
format but not what they actually typed, so debugging a typo means guessing.
Change the message to include `spec`, for example
`` `usage: owner/repo#123, got "${spec}"` ``. One line. Check whether
`packages/cli/src/upload.ts` or `run-review.ts` have a similar parser worth
the same fix while you are there, but only if it is the same one-line
change; do not go looking for a bigger refactor.

## 4. Nothing tests that `OUTPUT_STYLE` stays in sync with `STYLE.md`

`packages/domain/src/index.ts:3-6` says, in a comment directly above the
`OUTPUT_STYLE` constant: "STYLE.md at the repo root is the contract; this
constant is the copy every prompt surface ships to the model. Keep the two
in sync." `STYLE.md:15` repeats the same instruction from the other
direction. Nothing enforces it: `packages/domain/src/index.test.ts` never
references `OUTPUT_STYLE` or reads `STYLE.md`.

Add a test in `packages/domain/src/index.test.ts` that reads `STYLE.md` from
disk (it is two directories up: `../../../STYLE.md` relative to the test
file, or resolve from `import.meta.url`) and checks that `OUTPUT_STYLE`
covers the same rules, at minimum the em-dash rule and the "name concrete
files" rule. An exact string match is too brittle since the two files use
different wording on purpose; a keyword-presence check per rule is enough
to catch someone editing one file and forgetting the other.

## 5. `contentHash` has no direct unit test

`packages/application/src/hash.ts` is a small pure function, a deterministic
hex digest with a `length` parameter, used in six places across the
codebase: chunk ids (`chunks.ts:19`), wiki page slugs (`ingest-wiki.ts:30`),
the `skill_pack_hash` (`compiler.ts:48,63`), and `ProofArtifact.contentHash`
(`prove.ts:96`, `run-review.ts:141`). None of those call sites test the hash
function's own properties: that it is deterministic (same input, same
output, every call), that the `length` parameter is honored, and that two
different inputs produce different output for the sizes this codebase
actually uses (8, 12, 32, 64 chars).

Add `packages/application/src/hash.test.ts` with a handful of `expect`
assertions on `contentHash` directly. No other file needs to change.

## 6. `proofVerdict` and `diffCoveragePercent` have no direct unit test

`packages/domain/src/index.ts:317-337`. These two pure functions are the
entire rule that decides the `verit / behavior-proof` Check conclusion; the
comment directly above `proofVerdict` calls it "the one rule that turns a
prove run into a verdict." They are only exercised indirectly, through
`behaviorProofCheck` in `packages/application/src/check.ts`'s own tests.
There is no test in `packages/domain/src/index.test.ts` that calls
`proofVerdict` or `diffCoveragePercent` directly with a table of inputs:
`null`, a refused outcome, exit code 0, exit code 1, and (for
`diffCoveragePercent`) a diff exactly at the budget, just under it, and just
over it.

Add that table as direct tests in `packages/domain/src/index.test.ts`. Given
how much rides on this function per `CONTRIBUTING.md`'s "part that matters
most" section, a focused, readable test of the function in isolation is
worth having even though the behavior is already covered end to end
elsewhere.

## 7. Add Ruby symbol extraction to the tree-sitter adapter

`README.md:337-340` states plainly: tree-sitter ingest covers TypeScript,
TSX, JavaScript, Python, Rust and Go; every other language falls back to the
regex parser. Ruby is not covered.

`packages/adapters/treesitter/src/index.ts:25-37` (`GRAMMAR_WASM`) and
`:40-66` (`DECL_KIND`) is the whole surface. `tree-sitter-ruby` (npm,
version 0.23.1 at the time of writing) ships a prebuilt
`tree-sitter-ruby.wasm` at its package root, the same layout the six
existing grammars already use, so this follows the exact pattern already in
the file: add the dependency to `packages/adapters/treesitter/package.json`,
add an `rb` entry to `GRAMMAR_WASM` pointing at
`tree-sitter-ruby/tree-sitter-ruby.wasm`, add Ruby's declaration node types
(`method`, `class`, `module`) to `DECL_KIND`, add a
`packages/adapters/treesitter/fixtures/sample.rb`, and extend
`packages/adapters/treesitter/src/treesitter.test.ts` with a case mirroring
the existing Python or Go one.

## 8. Add Java symbol extraction to the tree-sitter adapter

Same gap and same fix shape as #7, for Java. `tree-sitter-java` (npm,
0.23.5) ships `tree-sitter-java.wasm` at its package root. Add it to
`GRAMMAR_WASM` and `DECL_KIND` in
`packages/adapters/treesitter/src/index.ts:25-37,40-66`
(`class_declaration`, `interface_declaration`, `method_declaration`,
`enum_declaration` are the ones worth mapping first), add
`packages/adapters/treesitter/fixtures/sample.java`, and a matching test
case in `treesitter.test.ts`.

## 9. Add C symbol extraction to the tree-sitter adapter

Same gap and shape again, for C. `tree-sitter-c` (npm, 0.24.1) ships
`tree-sitter-c.wasm` at its package root. C has no classes, so `DECL_KIND`
only needs `function_definition` (already present, shared with Python: check
it does not collide badly) and `struct_specifier`. Add the `c` extension to
`GRAMMAR_WASM`, add `packages/adapters/treesitter/fixtures/sample.c`, and a
test case in `treesitter.test.ts`.

## 10. Add PHP symbol extraction to the tree-sitter adapter

Same gap and shape again, for PHP, with one wrinkle worth knowing before you
start: `tree-sitter-php` (npm, 0.24.2) ships two wasm files,
`tree-sitter-php.wasm` (full PHP, including files with embedded HTML) and
`tree-sitter-php_only.wasm` (PHP-only files, no HTML). Use
`tree-sitter-php.wasm`, since that matches how PHP files actually look in
the wild. Map `php` to it in `GRAMMAR_WASM`, add `function_definition`,
`class_declaration`, and `method_declaration` to `DECL_KIND`, add
`packages/adapters/treesitter/fixtures/sample.php`, and a test case in
`treesitter.test.ts`.
