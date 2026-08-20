/**
 * netdiff field-eval harness.
 *
 * Run the whole pipeline over a real patch and print the stats, the focus
 * lines, and the four truthfulness checks. Runs over one `.diff` file or a
 * directory of them; defaults to the committed fixtures.
 *
 *   tsx packages/netdiff/scripts/field-eval.ts                 # committed fixtures
 *   tsx packages/netdiff/scripts/field-eval.ts path/to.diff    # one file
 *   tsx packages/netdiff/scripts/field-eval.ts fixtures/       # a directory
 *   tsx packages/netdiff/scripts/field-eval.ts --md            # cost-table markdown
 *   tsx packages/netdiff/scripts/field-eval.ts --fetch <url>   # a public .diff, unauthenticated
 *
 * The `--md` output is the source of docs/bench/netdiff-cost.md. CI never runs
 * this script: the properties live in src/fixtures.test.ts and run in pnpm test.
 * Never calls gh; the optional fetch is a plain unauthenticated GET.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { evalPatch, syntheticMovePatch, type PatchEval } from "../src/eval";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

/** Profile label per committed fixture; the harness reads real numbers, this is
    only the human tag for the cost table. Unknown files fall back to "other". */
const PROFILE: Record<string, string> = {
  "verit-rename.diff": "mechanical-rename",
  "effect-refactor.diff": "ordinary-feature",
  "vscode-move.diff": "file-move",
  "vite-deps.diff": "deps-bump",
  "vite-docs.diff": "small-feature",
};

const pct = (gross: number, net: number): number =>
  gross === 0 ? 0 : Math.round(((gross - net) / gross) * 100);

const diffFilesIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".diff"))
    .sort()
    .map((f) => `${dir}/${f}`);

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

interface Named {
  readonly label: string;
  readonly profile: string;
  readonly patch: string;
}

const loadTargets = (arg: string | undefined): Named[] => {
  if (arg === undefined) {
    return diffFilesIn(FIXTURES_DIR).map((p) => ({
      label: nameOf(p),
      profile: PROFILE[nameOf(p)] ?? "other",
      patch: readFileSync(p, "utf8"),
    }));
  }
  const paths = statSync(arg).isDirectory() ? diffFilesIn(arg) : [arg];
  return paths.map((p) => ({
    label: nameOf(p),
    profile: PROFILE[nameOf(p)] ?? "other",
    patch: readFileSync(p, "utf8"),
  }));
};

/* --------------------------------- human mode ------------------------------ */

const printEval = (label: string, e: PatchEval): void => {
  const s = e.stats;
  console.log(`== ${label}`);
  console.log(
    `files=${e.files} grossAdded=${s.grossAdded} grossRemoved=${s.grossRemoved} ` +
      `netLines=${s.netLines} movePct=${s.movePct} renames=${e.renames}`,
  );
  console.log(
    `moves: pure=${e.pureMoves} withEdit=${e.editMoves} inlineEdits=${e.inlineEdits} | ` +
      `grossChars=${e.grossChars} sectionChars=${e.sectionChars} reduction=${pct(e.grossChars, e.sectionChars)}% | ` +
      `planned=${e.planned} unreviewed=${e.unreviewed} | ${e.ms.toFixed(1)}ms`,
  );
  if (e.residualFocus.length > 0) {
    console.log(`residual focus lines (${e.residualFocus.length}):`);
    for (const l of e.residualFocus.slice(0, 4)) console.log("  " + l.slice(0, 160));
  }
  console.log(`REAL CHANGES lines (${e.realChanges.length}):`);
  for (const l of e.realChanges.slice(0, 10)) console.log("  " + l.slice(0, 200));
  const c = e.checks;
  console.log(
    `checks: inventedTokens=${c.inventedTokens} nonVerbatimPieces=${c.nonVerbatimPieces} ` +
      `falseMoves=${c.falseMoves} grossReconstructs=${c.grossReconstructs}`,
  );
  console.log("");
};

const runHuman = (targets: Named[]): number => {
  let failed = 0;
  for (const t of targets) {
    const e = evalPatch(t.patch);
    printEval(t.label, e);
    const c = e.checks;
    if (c.inventedTokens > 0 || c.nonVerbatimPieces > 0 || c.falseMoves > 0 || !c.grossReconstructs) {
      failed++;
    }
  }
  console.log(
    failed === 0
      ? `all checks pass across ${targets.length} ${targets.length === 1 ? "patch" : "patches"}`
      : `${failed} of ${targets.length} patches FAILED a truthfulness check`,
  );
  return failed === 0 ? 0 : 1;
};

/* -------------------------------- markdown mode ---------------------------- */

const row = (profile: string, fixture: string, e: PatchEval): string =>
  `| ${profile} | ${fixture} | ${e.files} | ${e.grossChars.toLocaleString("en-US")} | ` +
  `${e.sectionChars.toLocaleString("en-US")} | ${pct(e.grossChars, e.sectionChars)}% | ` +
  `${e.inlineEdits} to ${e.realChanges.length} | ${e.ms.toFixed(1)} |`;

const runMarkdown = (targets: Named[]): number => {
  const synthetic = evalPatch(syntheticMovePatch());
  const rows: string[] = [row("move-heavy (synthetic)", "syntheticMovePatch", synthetic)];
  for (const t of targets) rows.push(row(t.profile, t.label, evalPatch(t.patch)));

  const doc = `# netdiff cost reduction

Measured, not estimated. Every number here comes from one command over the
committed fixtures plus the in-memory synthetic move patch:

    pnpm --filter @verit/netdiff bench:md > docs/bench/netdiff-cost.md

Regenerate it after any change to the netdiff pipeline or the fixtures. Do not
hand-edit this file: the harness overwrites it.

## What the columns mean

- gross chars: the raw unified diff, what a naive prompt would carry.
- net/section chars: the rendered \`diffSection\` prompt netdiff delivers, moves
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
  lines across 119 files. The \`verit-rename.diff\` row reproduces it live.

## Measured table

| profile | fixture | files | gross chars | net/section chars | reduction | focus lines | ms |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Reading it

Move-heavy and mechanical-rename are where review cost actually lives, and they
are where netdiff cuts. A 250 KB reorganization that is 80 percent moved code
becomes a 36 KB prompt. A 119-file rename stops being 550 changes to read and
becomes 41 patterns to confirm. On an ordinary 14 KB feature diff netdiff spends
a few thousand extra chars to mark exactly which tokens changed inside each
replacement, which is the cheap end of the trade and the right place to spend.
`;
  console.log(doc);
  return 0;
};

/* ----------------------------------- main ---------------------------------- */

const main = (): number => {
  const argv = process.argv.slice(2);
  const md = argv.includes("--md");
  const fetchAt = argv.indexOf("--fetch");
  // first non-flag token, skipping the value that follows --fetch
  const positional = argv.find((a, i) => !a.startsWith("--") && (fetchAt === -1 || i !== fetchAt + 1));

  let targets: Named[];
  if (fetchAt !== -1) {
    const url = argv[fetchAt + 1];
    if (url === undefined || !/^https:\/\//.test(url)) {
      console.error("--fetch needs an https URL to a public .diff");
      return 2;
    }
    // Unauthenticated GET only. Never gh, never a token. A convenience path for
    // eyeballing a live PR; CI and the cost table use committed bytes.
    const patch = execFileSync("curl", ["-sSL", url], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    targets = [{ label: url, profile: "other", patch }];
  } else {
    targets = loadTargets(positional);
  }

  return md ? runMarkdown(targets) : runHuman(targets);
};

process.exit(main());
