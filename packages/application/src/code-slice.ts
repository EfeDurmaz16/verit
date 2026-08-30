import type { Claim } from "@verit/domain";
import { looksLikeTest } from "./probe-select";

/*
 * What the model gets to look at.
 *
 * Measured on the first real run: the probe writer was handed the raw diff and
 * nothing else. It could see that a function changed and could not see what
 * calls it, what it exports, or what the repository's tests look like, and it
 * wrote probes for code it had never read. One of three failed on both sides.
 *
 * A diff is a poor unit for this. The useful unit is what the change can reach:
 * the symbols it touched, the places that call them, and the tests that already
 * exercise them. That is a slice, and it is per claim, because two claims about
 * the same pull request usually concern different code.
 *
 * The honest ceiling is stated here rather than in a footnote: callers are
 * found through imports, not through a call graph. A file that imports the
 * changed module and mentions the symbol is a caller; one that reaches it
 * through a re-export or a dynamic lookup is not found. That is a recall
 * problem, never a correctness one, because everything in a slice really is in
 * the repository.
 */

export interface IndexedSymbol {
  readonly name: string;
  /** Declaration kind from the parser. `import` marks a dependency edge. */
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface FileSymbols {
  readonly path: string;
  readonly symbols: readonly IndexedSymbol[];
}

export interface RepoIndex {
  readonly files: readonly FileSymbols[];
}

export interface SliceEntry {
  readonly path: string;
  readonly symbol: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}

export interface FileFacts {
  readonly path: string;
  readonly declares: readonly string[];
  readonly imports: readonly string[];
}

export interface CodeSlice {
  readonly claimId: string;
  /** Symbols the change actually touched. */
  readonly changed: readonly SliceEntry[];
  /** Symbols in files that import a changed file and name a changed symbol. */
  readonly callers: readonly SliceEntry[];
  /** The subset of callers the repository treats as tests. */
  readonly tests: readonly SliceEntry[];
  readonly files: readonly FileFacts[];
  /** Set when the budget dropped entries, so the prompt can say so. */
  readonly truncated?: string;
}

/** Chars a slice may spend before it starts costing more than the diff did. */
export const DEFAULT_SLICE_BUDGET = 24_000;

const basename = (path: string): string => path.split("/").pop() ?? path;
const withoutExt = (name: string): string => name.replace(/\.[^.]+$/, "");

const declaredIn = (f: FileSymbols): readonly string[] =>
  f.symbols.filter((s) => s.kind !== "import").map((s) => s.name);

const importsIn = (f: FileSymbols): readonly string[] =>
  f.symbols.filter((s) => s.kind === "import").map((s) => s.name);

/** True when `importer` names `target` in one of its import specifiers. */
export const importsFile = (importer: FileSymbols, targetPath: string): boolean => {
  const stem = withoutExt(basename(targetPath));
  if (stem === "") return false;
  return importsIn(importer).some((spec) => {
    const s = spec.replace(/\\/g, "/");
    return s === targetPath || withoutExt(basename(s)) === stem;
  });
};

const overlaps = (sym: IndexedSymbol, lines: ReadonlySet<number> | undefined): boolean => {
  if (lines === undefined) return false;
  for (const line of lines) {
    if (line >= sym.startLine && line <= sym.endLine) return true;
  }
  return false;
};

export interface BuildSliceInput {
  readonly claim: Claim;
  /** Per path, the head lines this change touched. Comes from netdiff. */
  readonly changedLines: ReadonlyMap<string, ReadonlySet<number>>;
  readonly index: RepoIndex;
  /** Reads a span from the head checkout. Returns "" when it cannot. */
  readonly readSpan: (path: string, startLine: number, endLine: number) => string;
  readonly budgetChars?: number;
}

/**
 * The slice for one claim.
 *
 * Order of spending is deliberate. The changed code is what the claim is about
 * and is never dropped. Tests come next, because an existing test is the
 * cheapest thing to imitate and often the probe itself. Callers come last: they
 * are context, and a probe that never sees one is worse informed rather than
 * wrong.
 */
export const buildSlice = (input: BuildSliceInput): CodeSlice => {
  const budget = input.budgetChars ?? DEFAULT_SLICE_BUDGET;
  const regions = new Set(input.claim.regions.map((r) => r.replace(/\\/g, "/")));
  const byPath = new Map(input.index.files.map((f) => [f.path, f]));

  const entry = (path: string, s: IndexedSymbol): SliceEntry => ({
    path,
    symbol: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
    content: input.readSpan(path, s.startLine, s.endLine),
  });

  // 1. What the change touched, inside the regions this claim names.
  const changed: SliceEntry[] = [];
  const changedNames = new Set<string>();
  for (const path of regions) {
    const file = byPath.get(path);
    if (file === undefined) continue;
    const lines = input.changedLines.get(path);
    for (const sym of file.symbols) {
      if (sym.kind === "import") continue;
      if (!overlaps(sym, lines)) continue;
      changed.push(entry(path, sym));
      changedNames.add(sym.name);
    }
  }

  // 2. Files that import a changed file and mention one of its symbols.
  const callers: SliceEntry[] = [];
  const tests: SliceEntry[] = [];
  for (const file of input.index.files) {
    if (regions.has(file.path)) continue;
    const importsAChangedFile = [...regions].some((r) => importsFile(file, r));
    if (!importsAChangedFile) continue;
    const naming = file.symbols.filter(
      (s) => s.kind !== "import" && (changedNames.has(s.name) || changedNames.size === 0),
    );
    const picked = naming.length > 0 ? naming : file.symbols.filter((s) => s.kind !== "import");
    for (const sym of picked.slice(0, 4)) {
      const e = entry(file.path, sym);
      if (looksLikeTest(file.path)) tests.push(e);
      else callers.push(e);
    }
  }

  // 3. Spend the budget in that order and say so when something is dropped.
  const kept = { changed: [] as SliceEntry[], tests: [] as SliceEntry[], callers: [] as SliceEntry[] };
  let spent = 0;
  let dropped = 0;
  for (const [bucket, list] of [
    ["changed", changed],
    ["tests", tests],
    ["callers", callers],
  ] as const) {
    for (const e of list) {
      const cost = e.content.length;
      // the changed code is what the claim is about: never dropped
      if (bucket !== "changed" && spent + cost > budget) {
        dropped += 1;
        continue;
      }
      kept[bucket].push(e);
      spent += cost;
    }
  }

  const files: FileFacts[] = [...regions]
    .map((p) => byPath.get(p))
    .filter((f): f is FileSymbols => f !== undefined)
    .map((f) => ({ path: f.path, declares: declaredIn(f), imports: importsIn(f) }));

  return {
    claimId: input.claim.id,
    changed: kept.changed,
    callers: kept.callers,
    tests: kept.tests,
    files,
    ...(dropped > 0
      ? { truncated: `${dropped} related symbol(s) left out to stay inside ${budget} chars` }
      : {}),
  };
};

/**
 * The slice as the probe writer reads it.
 *
 * Every line is repository text or a path. Nothing here is a summary, because
 * a probe written against a paraphrase is a probe written against something
 * that does not exist.
 */
export const renderSlice = (slice: CodeSlice): string => {
  const parts: string[] = [];

  if (slice.files.length > 0) {
    parts.push(
      `FILES THIS CLAIM TOUCHES:\n${slice.files
        .map((f) => `- ${f.path}\n    declares: ${f.declares.slice(0, 12).join(", ") || "(none)"}\n    imports: ${f.imports.slice(0, 12).join(", ") || "(none)"}`)
        .join("\n")}`,
    );
  }

  const block = (title: string, entries: readonly SliceEntry[]): void => {
    if (entries.length === 0) return;
    parts.push(
      `${title}:\n${entries
        .map((e) => `--- ${e.path}:${e.startLine}-${e.endLine} (${e.kind} ${e.symbol})\n${e.content}`)
        .join("\n\n")}`,
    );
  };

  block("CODE THE CHANGE TOUCHED", slice.changed);
  block("TESTS THAT ALREADY REACH IT", slice.tests);
  block("CODE THAT CALLS IT", slice.callers);

  if (slice.truncated !== undefined) {
    parts.push(`NOTE: ${slice.truncated}. What is above is complete as far as it goes.`);
  }
  return parts.join("\n\n");
};

/*
 * Whether a claim is about behavior the base commit does not have.
 *
 * This was a question put to the model, and it answered yes every time: on the
 * measured run all eleven generated probes came back marked as preconditions,
 * which is not a judgement so much as a coin that only has one side. It is also
 * a question the diff already answers. A file the diff creates did not exist
 * before, and a claim that only speaks about such files is about new behavior.
 *
 * Deriving it costs nothing and cannot drift, which is the general rule here:
 * ask the model for the things only a reader can supply, and compute the rest.
 */

/** Paths this diff creates. `new file mode` is git's own marker for it. */
export const addedPaths = (diff: string): ReadonlySet<string> => {
  const added = new Set<string>();
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.startsWith("new file mode")) continue;
    // walk back to the `diff --git a/x b/x` header this belongs to
    for (let j = i; j >= 0; j--) {
      const header = lines[j];
      if (header === undefined || !header.startsWith("diff --git ")) continue;
      const path = header.split(" b/")[1];
      if (path !== undefined && path !== "") added.add(path);
      break;
    }
  }
  return added;
};

/**
 * True when every file this claim speaks for is one the change created.
 *
 * Deliberately strict. A claim that touches one new file and one existing file
 * is about a change to something that already ran, and calling it new would
 * send it down the precondition path where an absent base side is expected.
 */
export const isAboutNewBehavior = (
  regions: readonly string[],
  added: ReadonlySet<string>,
): boolean => {
  const paths = regions.map((r) => r.replace(/\\/g, "/")).filter((r) => r !== "");
  return paths.length > 0 && paths.every((p) => added.has(p));
};
