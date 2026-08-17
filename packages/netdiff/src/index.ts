/* Net-diff preprocessor: the deterministic, zero-model-call layer that shrinks
   review scope before any lane prompt is built.

   A large diff is usually mostly moved code: a file split, a function hoisted,
   a rename with one edited line. Reviewing moved code as if it were new burns
   the whole prompt budget on content that already existed. This package
   factors moves out and keeps only what a reviewer genuinely has to read:
   new blocks, the residual edits hiding inside moved blocks, and outright
   deletions. Deletions are kept as reviewable regions on purpose: deleting a
   permission check is as reviewable as adding one.

   Everything here is a pure function of its input. No I/O, no Date, no
   randomness. Same patch in, same plan out, always. */

import { DIFF_BUDGET_CHARS, diffCoveragePercent } from "@verit/domain";

/* ---------------------------------- types --------------------------------- */

export interface DiffLine {
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
  /** old-file line number; null for added lines */
  readonly oldNo: number | null;
  /** new-file line number; null for removed lines */
  readonly newNo: number | null;
}

export interface Hunk {
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface FileDelta {
  /** null when the file is newly added */
  readonly oldPath: string | null;
  /** null when the file is deleted */
  readonly newPath: string | null;
  readonly status: FileStatus;
  readonly hunks: readonly Hunk[];
}

/** A contiguous run of added or removed lines. The unit move detection works on. */
export interface Block {
  /** newPath for added blocks, oldPath for removed blocks */
  readonly file: string;
  /** first line number: new-file numbering for adds, old-file for removals */
  readonly startLine: number;
  readonly lines: readonly string[];
}

/**
 * The token-level difference between one before line and one after line.
 * `removedTokens` and `addedTokens` are the exact tokens that changed, from an
 * LCS alignment. `beforeContext` and `afterContext` are raw slices of the two
 * lines covering the changed span plus a few tokens of context on each side,
 * with the original spacing kept, ready to render as `before` -> `after`.
 * Identical token streams (including whitespace-only differences) produce the
 * empty edit: both arrays empty, both contexts empty.
 */
export interface TokenEdit {
  readonly removedTokens: readonly string[];
  readonly addedTokens: readonly string[];
  readonly beforeContext: string;
  readonly afterContext: string;
}

/** One removed residual line matched to one added residual line, with the
    token-level edit between them. */
export interface ResidualPair {
  readonly removedLine: string;
  readonly addedLine: string;
  readonly edit: TokenEdit;
}

export interface ResidualPairing {
  readonly pairs: readonly ResidualPair[];
  /** removed residual lines no added line matched: plain deletions */
  readonly unmatchedRemoved: readonly string[];
  /** added residual lines no removed line matched: plain additions */
  readonly unmatchedAdded: readonly string[];
}

export interface MovePair {
  readonly kind: "pure_move" | "move_with_edit";
  readonly from: Block;
  readonly to: Block;
  /** 1 for pure moves; shingled-token Jaccard for near moves */
  readonly similarity: number;
  /** raw lines of `to` that did not exist in `from`: the genuinely new edit */
  readonly toResidual: readonly string[];
  /** raw lines of `from` that did not survive into `to` */
  readonly fromResidual: readonly string[];
  /** residual lines matched across the two sides, each with its token-level
      edit; empty for pure moves. Residual lines not in any pair are plain
      additions or deletions. */
  readonly residualPairs: readonly ResidualPair[];
}

export interface MoveReport {
  readonly pairs: readonly MovePair[];
  /** added blocks with no counterpart: genuinely new content */
  readonly newBlocks: readonly Block[];
  /** removed blocks with no counterpart: genuinely deleted content */
  readonly deletedBlocks: readonly Block[];
}

export type RegionKind = "new" | "residual" | "deletion";

/** One reviewable region of the net diff, with its rendered prompt text. */
export interface NetRegion {
  readonly kind: RegionKind;
  readonly file: string;
  readonly startLine: number;
  readonly lines: readonly string[];
  /** set on residual regions: where the surrounding block moved from */
  readonly movedFrom?: {
    readonly file: string;
    readonly startLine: number;
    readonly similarity: number;
  };
  /** set on residual regions: the token-level pairs behind the focus lines */
  readonly residualPairs?: readonly ResidualPair[];
  /** deterministic rendered text, the unit the char budget applies to */
  readonly content: string;
}

export interface RenameCandidate {
  readonly from: string;
  readonly to: string;
  /** added-side lines that changed along with the rename */
  readonly editedLines: number;
}

export interface NetDiffStats {
  readonly grossAdded: number;
  readonly grossRemoved: number;
  /** added-side lines matched to a removed counterpart */
  readonly movedAdded: number;
  /** removed-side lines matched to an added counterpart */
  readonly movedRemoved: number;
  /** added-side lines that are edits inside moved blocks */
  readonly residualAdded: number;
  /** removed-side lines dropped inside moved blocks */
  readonly residualRemoved: number;
  /** lines of added blocks with no counterpart */
  readonly newLines: number;
  /** lines of removed blocks with no counterpart */
  readonly deletedLines: number;
  /** the genuinely new content a reviewer must read: newLines + residualAdded */
  readonly netLines: number;
  /** whole percent of gross changed lines (both sides) accounted for by moves */
  readonly movePct: number;
  /** total rendered chars of all net regions: the coverage/budget unit */
  readonly netChars: number;
}

export interface NetDiff {
  readonly regions: readonly NetRegion[];
  readonly stats: NetDiffStats;
  readonly renameCandidates: readonly RenameCandidate[];
  readonly moves: MoveReport;
}

export interface PlannedRegion extends NetRegion {
  /** rank score: path risk x kind weight x size, higher reviews first */
  readonly score: number;
  /** true when the region was cut to fit the tail of the budget */
  readonly truncated: boolean;
}

export interface ReviewPlan {
  /** ranked regions packed into the budget, in review order */
  readonly regions: readonly PlannedRegion[];
  /** ranked regions that did not fit: the lane must report them unreviewed */
  readonly unreviewed: readonly NetRegion[];
  readonly packedChars: number;
  readonly totalNetChars: number;
}

/* --------------------------------- parsing -------------------------------- */

const stripPrefix = (p: string): string => p.replace(/^[ab]\//, "");

const parsePathToken = (raw: string): string | null => {
  const p = raw.trim();
  return p === "/dev/null" ? null : stripPrefix(p);
};

/**
 * Parse a unified diff (git or plain) into per-file deltas with positioned
 * add/remove lines. O(n) over input lines. Rename headers and /dev/null
 * markers set the file status; binary file notices produce a delta with no
 * hunks. Input that contains no file headers parses to an empty array.
 *
 * The @@ line counts drive hunk membership, so a removed line whose content
 * begins with "-- " (which prints as "--- ") is never mistaken for a file
 * header. Headers are only recognized between hunks.
 */
export const parseDiff = (patch: string): FileDelta[] => {
  interface Mutable {
    oldPath: string | null;
    newPath: string | null;
    renamed: boolean;
    sawOldHeader: boolean;
    hunks: Hunk[];
  }
  const out: FileDelta[] = [];
  let file: Mutable | null = null;
  let hunk: { header: string; oldStart: number; newStart: number; lines: DiffLine[] } | null =
    null;
  let oldNo = 0;
  let newNo = 0;
  /** lines the current hunk still owes per the @@ counts */
  let oldLeft = 0;
  let newLeft = 0;

  const flushHunk = () => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
    oldLeft = 0;
    newLeft = 0;
  };
  const flushFile = () => {
    flushHunk();
    if (!file) return;
    if (file.oldPath !== null || file.newPath !== null) {
      const status: FileStatus =
        file.oldPath === null
          ? "added"
          : file.newPath === null
            ? "deleted"
            : file.renamed || file.oldPath !== file.newPath
              ? "renamed"
              : "modified";
      out.push({
        oldPath: file.oldPath,
        newPath: file.newPath,
        status,
        hunks: file.hunks,
      });
    }
    file = null;
  };

  for (const line of patch.split("\n")) {
    const inHunk = hunk !== null && (oldLeft > 0 || newLeft > 0);
    if (inHunk && hunk) {
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
        newLeft--;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
        oldLeft--;
      } else if (line.startsWith(" ") || line === "") {
        hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
      }
      // "\ No newline at end of file" does not count against the hunk
      continue;
    }
    if (line.startsWith("diff --git ")) {
      flushFile();
      // paths from the header as a fallback; --- / +++ lines override below
      const m = /^diff --git (?:"?a\/([^"]+)"?) (?:"?b\/([^"]+)"?)$/.exec(line);
      file = {
        oldPath: m?.[1] ?? null,
        newPath: m?.[2] ?? null,
        renamed: false,
        sawOldHeader: false,
        hunks: [],
      };
      continue;
    }
    if (line.startsWith("rename from ")) {
      if (file) {
        file.oldPath = line.slice("rename from ".length).trim();
        file.renamed = true;
      }
      continue;
    }
    if (line.startsWith("rename to ")) {
      if (file) {
        file.newPath = line.slice("rename to ".length).trim();
        file.renamed = true;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      // in a plain concatenated diff (no "diff --git"), a second old-file
      // header opens the next file
      if (file && (file.sawOldHeader || file.hunks.length > 0 || hunk !== null)) flushFile();
      flushHunk();
      if (!file) {
        file = { oldPath: null, newPath: null, renamed: false, sawOldHeader: false, hunks: [] };
      }
      file.oldPath = parsePathToken(line.slice(4));
      file.sawOldHeader = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!file) continue;
      file.newPath = parsePathToken(line.slice(4));
      // a plain diff of an added file shows --- /dev/null; without any old
      // header at all, the file can only be an addition
      if (!file.sawOldHeader) file.oldPath = null;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!file) continue;
      flushHunk();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      hunk = { header: line, oldStart: oldNo, newStart: newNo, lines: [] };
      continue;
    }
    // between hunks: "index ...", "Binary files ... differ", modes: skip
  }
  flushFile();
  return out;
};

/* ----------------------------- move detection ----------------------------- */

/** All whitespace stripped: an indent-only change is not an edit. */
const normLine = (s: string): string => s.replace(/\s+/g, "");

/** Exact-match key: normalized non-blank lines. Blank lines never separate a match. */
const blockKey = (b: Block): string =>
  b.lines
    .map(normLine)
    .filter((l) => l !== "")
    .join("\n");

/** true when the block normalizes to nothing but blank lines */
const isBlank = (b: Block): boolean => b.lines.every((l) => normLine(l) === "");

const blockOrder = (a: Block, b: Block): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine;

/**
 * Split one add-run or del-run into paragraphs at blank lines, blanks
 * attached to the preceding paragraph. A deleted file arrives as one giant
 * run; paragraph granularity is what lets a file split match half by half.
 */
const splitParagraphs = (file: string, start: number, lines: readonly string[]): Block[] => {
  const blocks: Block[] = [];
  let buf: string[] = [];
  let bufStart = start;
  let blankTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const blank = normLine(line) === "";
    if (!blank && blankTail && buf.some((l) => normLine(l) !== "")) {
      blocks.push({ file, startLine: bufStart, lines: buf });
      buf = [];
      bufStart = start + i;
    }
    buf.push(line);
    blankTail = blank;
  }
  if (buf.length > 0) blocks.push({ file, startLine: bufStart, lines: buf });
  return blocks;
};

/** Contiguous add-runs and del-runs across all hunks, paragraph-split, sorted. */
const extractBlocks = (
  deltas: readonly FileDelta[],
): { added: Block[]; removed: Block[] } => {
  const added: Block[] = [];
  const removed: Block[] = [];
  for (const d of deltas) {
    for (const h of d.hunks) {
      let run: { kind: "add" | "del"; start: number; lines: string[] } | null = null;
      const flush = () => {
        if (!run) return;
        const file = (run.kind === "add" ? d.newPath : d.oldPath) ?? "(unknown)";
        const target = run.kind === "add" ? added : removed;
        target.push(...splitParagraphs(file, run.start, run.lines));
        run = null;
      };
      for (const l of h.lines) {
        if (l.kind === "ctx") {
          flush();
          continue;
        }
        if (run && run.kind === l.kind) {
          run.lines.push(l.text);
          continue;
        }
        flush();
        run = {
          kind: l.kind,
          start: (l.kind === "add" ? l.newNo : l.oldNo) ?? 0,
          lines: [l.text],
        };
      }
      flush();
    }
  }
  added.sort(blockOrder);
  removed.sort(blockOrder);
  return { added, removed };
};

/**
 * Raw lines of `keep` whose normalized form is not covered by `other`, as a
 * multiset. Blank lines are never residual: adding or losing a blank line is
 * not an edit anyone reviews.
 */
const residualLines = (
  keep: readonly string[],
  other: readonly string[],
): string[] => {
  const counts = new Map<string, number>();
  for (const l of other) {
    const k = normLine(l);
    if (k === "") continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const l of keep) {
    const k = normLine(l);
    if (k === "") continue;
    const c = counts.get(k) ?? 0;
    if (c > 0) counts.set(k, c - 1);
    else out.push(l);
  }
  return out;
};

const tokenize = (b: Block): string[] => {
  const tokens: string[] = [];
  for (const line of b.lines) {
    for (const t of normLine(line).split(/[^A-Za-z0-9_]+/)) {
      if (t !== "") tokens.push(t);
    }
  }
  return tokens;
};

/** 3-token shingles; short blocks fall back to the raw token set. */
const shingles = (b: Block): Set<string> => {
  const tokens = tokenize(b);
  if (tokens.length < 3) return new Set(tokens);
  const set = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    set.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return set;
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
};

/**
 * Share of normalized non-blank lines the two blocks have in common, over the
 * larger block. Complements shingle Jaccard: a one-line edit in a ten-line
 * block barely dents line overlap but wipes a big share of its shingles.
 */
const lineOverlap = (a: Block, b: Block): number => {
  const counts = new Map<string, number>();
  let bLen = 0;
  for (const l of b.lines) {
    const k = normLine(l);
    if (k === "") continue;
    bLen++;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let aLen = 0;
  let matched = 0;
  for (const l of a.lines) {
    const k = normLine(l);
    if (k === "") continue;
    aLen++;
    const c = counts.get(k) ?? 0;
    if (c > 0) {
      counts.set(k, c - 1);
      matched++;
    }
  }
  const denom = Math.max(aLen, bLen);
  return denom === 0 ? 0 : matched / denom;
};

/* ------------------------- token-level residuals -------------------------- */

/** One token with its position in the raw line, so context keeps real spacing. */
interface LineToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Identifier runs (unicode letters, digits, underscore) or single punctuation
    chars. Whitespace only separates, so an indent or spacing change yields the
    same token stream. Single-char punctuation keeps `):` from gluing into one
    token, which would smear an edit across its neighbors. */
const LINE_TOKEN_RE = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

const tokenizeLine = (line: string): LineToken[] => {
  const out: LineToken[] = [];
  for (const m of line.matchAll(LINE_TOKEN_RE)) {
    const start = m.index ?? 0;
    out.push({ text: m[0], start, end: start + m[0].length });
  }
  return out;
};

const EMPTY_TOKEN_EDIT: TokenEdit = {
  removedTokens: [],
  addedTokens: [],
  beforeContext: "",
  afterContext: "",
};

/** Context tokens kept on each side of the changed span. */
const FOCUS_CONTEXT_TOKENS = 6;

/** Above this window-size product, skip the LCS and report the whole window. */
const LCS_CELL_CAP = 250_000;

/** Tokens of `win` that an LCS alignment against `other` cannot match. */
const unmatchedByLcs = (win: readonly string[], other: readonly string[]): string[] => {
  const n = win.length;
  const m = other.length;
  if (n === 0) return [];
  if (m === 0) return [...win];
  // ponytail: quadratic LCS, capped; lines are short, a minified monster falls back
  if (n * m > LCS_CELL_CAP) return [...win];
  // dp[i][j] = LCS length of win[i:], other[j:], flattened
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        win[i] === other[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const w = win[i];
    if (w !== undefined && w === other[j]) {
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      if (w !== undefined) out.push(w);
      i++;
    } else {
      j++;
    }
  }
  for (; i < n; i++) {
    const w = win[i];
    if (w !== undefined) out.push(w);
  }
  return out;
};

/** Raw slice of `line` spanning tokens [lo, hi), "" when the range is empty. */
const sliceTokens = (line: string, tokens: readonly LineToken[], lo: number, hi: number): string => {
  const first = tokens[lo];
  const last = tokens[hi - 1];
  return hi <= lo || first === undefined || last === undefined
    ? ""
    : line.slice(first.start, last.end);
};

/**
 * Token-level diff of one line pair. Tokenizes on whitespace and
 * identifier/punctuation boundaries, trims the common token prefix and suffix,
 * then runs an LCS inside the remaining window so `removedTokens` and
 * `addedTokens` are exactly the tokens that changed, even across several spans.
 * `beforeContext` and `afterContext` are raw slices of the two lines covering
 * that window plus up to 6 context tokens per side. Quadratic in the window
 * size, which is fine for lines. Pure and deterministic.
 */
export const tokenDiff = (before: string, after: string): TokenEdit => {
  const a = tokenizeLine(before);
  const b = tokenizeLine(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p]?.text === b[p]?.text) p++;
  if (p === a.length && p === b.length) return EMPTY_TOKEN_EDIT;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    a[a.length - 1 - s]?.text === b[b.length - 1 - s]?.text
  ) {
    s++;
  }
  const winA = a.slice(p, a.length - s).map((t) => t.text);
  const winB = b.slice(p, b.length - s).map((t) => t.text);
  return {
    removedTokens: unmatchedByLcs(winA, winB),
    addedTokens: unmatchedByLcs(winB, winA),
    beforeContext: sliceTokens(
      before,
      a,
      Math.max(0, p - FOCUS_CONTEXT_TOKENS),
      Math.min(a.length, a.length - s + FOCUS_CONTEXT_TOKENS),
    ),
    afterContext: sliceTokens(
      after,
      b,
      Math.max(0, p - FOCUS_CONTEXT_TOKENS),
      Math.min(b.length, b.length - s + FOCUS_CONTEXT_TOKENS),
    ),
  };
};

/** Minimum token Jaccard for a removed and an added residual line to pair. */
export const RESIDUAL_PAIR_THRESHOLD = 0.5;

const lineTokenSet = (line: string): Set<string> =>
  new Set(tokenizeLine(line).map((t) => t.text));

/**
 * Match the removed residual lines of one move_with_edit block to its added
 * residual lines, so each matched pair can carry a token-level edit. Greedy
 * over all cross pairs by token-set Jaccard, best score first, deterministic
 * index tie-break, each line used at most once, scores below 0.5 never pair.
 * Unmatched lines stay plain deletions and additions. Residual counts are
 * small, so the quadratic scoring does not matter. Pure and deterministic.
 */
export const pairResidualLines = (
  removed: readonly string[],
  added: readonly string[],
): ResidualPairing => {
  const removedSets = removed.map(lineTokenSet);
  const addedSets = added.map(lineTokenSet);
  const candidates: { ri: number; ai: number; score: number }[] = [];
  for (let ri = 0; ri < removed.length; ri++) {
    const rSet = removedSets[ri];
    if (rSet === undefined || rSet.size === 0) continue;
    for (let ai = 0; ai < added.length; ai++) {
      const aSet = addedSets[ai];
      if (aSet === undefined || aSet.size === 0) continue;
      const score = jaccard(rSet, aSet);
      if (score >= RESIDUAL_PAIR_THRESHOLD) candidates.push({ ri, ai, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || x.ri - y.ri || x.ai - y.ai);
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const matched: { ri: number; ai: number }[] = [];
  for (const c of candidates) {
    if (usedRemoved.has(c.ri) || usedAdded.has(c.ai)) continue;
    usedRemoved.add(c.ri);
    usedAdded.add(c.ai);
    matched.push({ ri: c.ri, ai: c.ai });
  }
  matched.sort((x, y) => x.ri - y.ri || x.ai - y.ai);
  return {
    pairs: matched.map(({ ri, ai }) => {
      const removedLine = removed[ri] ?? "";
      const addedLine = added[ai] ?? "";
      return { removedLine, addedLine, edit: tokenDiff(removedLine, addedLine) };
    }),
    unmatchedRemoved: removed.filter((_, i) => !usedRemoved.has(i)),
    unmatchedAdded: added.filter((_, i) => !usedAdded.has(i)),
  };
};

/* ----------------------------- near-move pass ------------------------------ */

/** Near-move threshold: below this, an added block is new content. */
export const MOVE_SIMILARITY_THRESHOLD = 0.85;

/** Bounds the near-move comparisons per added block. */
const MAX_CANDIDATES = 64;

/**
 * Match removed blocks to added blocks within and across files.
 *
 * Pass 1, exact: blocks are keyed by their whitespace-stripped content, so an
 * exact (or indent-only-changed) move pairs by one map lookup. Multiset
 * semantics: each removed copy pairs at most one added copy, so a repeated
 * block never double-matches. O(total lines) for hashing plus O(blocks).
 *
 * Pass 2, near: leftover blocks are bucketed by normalized first line and by
 * normalized last line. Only bucket collisions are compared, capped at 64
 * candidates per block and pre-filtered to a 2x size ratio, which keeps the
 * pathological repeated-boilerplate case from going O(n^2). Similarity is
 * Jaccard over 3-token shingles; at or above 0.85 the pair is a
 * move_with_edit and the multiset line diff is carried as the residual edit.
 * A near pair whose residuals are empty on both sides (a pure reorder or
 * reformat) is reported as a pure move.
 */
export const detectMoves = (deltas: readonly FileDelta[]): MoveReport => {
  const { added, removed } = extractBlocks(deltas);
  const pairs: MovePair[] = [];
  const consumedRemoved = new Set<Block>();
  const consumedAdded = new Set<Block>();

  // pass 1: exact content match, whitespace ignored
  const byKey = new Map<string, Block[]>();
  for (const r of removed) {
    if (isBlank(r)) continue;
    const key = blockKey(r);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }
  for (const a of added) {
    if (isBlank(a)) continue;
    const bucket = byKey.get(blockKey(a));
    const from = bucket?.shift();
    if (!from) continue;
    consumedAdded.add(a);
    consumedRemoved.add(from);
    pairs.push({
      kind: "pure_move",
      from,
      to: a,
      similarity: 1,
      toResidual: [],
      fromResidual: [],
      residualPairs: [],
    });
  }

  // pass 2: near match on the leftovers, bucketed by first and last line
  const leftoverRemoved = removed.filter((r) => !consumedRemoved.has(r) && !isBlank(r));
  const buckets = new Map<string, Block[]>();
  const bucketAdd = (key: string, b: Block) => {
    const list = buckets.get(key);
    if (list) list.push(b);
    else buckets.set(key, [b]);
  };
  for (const r of leftoverRemoved) {
    const first = normLine(r.lines[0] ?? "");
    const last = normLine(r.lines[r.lines.length - 1] ?? "");
    if (first !== "") bucketAdd(`F:${first}`, r);
    if (last !== "" && last !== first) bucketAdd(`L:${last}`, r);
  }
  const shingleCache = new Map<Block, Set<string>>();
  const shinglesOf = (b: Block): Set<string> => {
    const hit = shingleCache.get(b);
    if (hit) return hit;
    const s = shingles(b);
    shingleCache.set(b, s);
    return s;
  };
  for (const a of added) {
    if (consumedAdded.has(a) || isBlank(a)) continue;
    const first = normLine(a.lines[0] ?? "");
    const last = normLine(a.lines[a.lines.length - 1] ?? "");
    const seen = new Set<Block>();
    const candidates: Block[] = [];
    for (const key of [first === "" ? null : `F:${first}`, last === "" ? null : `L:${last}`]) {
      if (key === null) continue;
      for (const r of buckets.get(key) ?? []) {
        if (consumedRemoved.has(r) || seen.has(r)) continue;
        const ratio = r.lines.length / a.lines.length;
        if (ratio < 0.5 || ratio > 2) continue;
        seen.add(r);
        candidates.push(r);
        if (candidates.length >= MAX_CANDIDATES) break;
      }
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    let best: Block | null = null;
    let bestSim = 0;
    const aShingles = shinglesOf(a);
    for (const r of candidates) {
      const sim = Math.max(jaccard(aShingles, shinglesOf(r)), lineOverlap(a, r));
      if (sim > bestSim) {
        best = r;
        bestSim = sim;
      }
    }
    if (best === null || bestSim < MOVE_SIMILARITY_THRESHOLD) continue;
    consumedAdded.add(a);
    consumedRemoved.add(best);
    const toResidual = residualLines(a.lines, best.lines);
    const fromResidual = residualLines(best.lines, a.lines);
    const pure = toResidual.length === 0 && fromResidual.length === 0;
    pairs.push({
      kind: pure ? "pure_move" : "move_with_edit",
      from: best,
      to: a,
      similarity: pure ? 1 : bestSim,
      toResidual,
      fromResidual,
      residualPairs: pure ? [] : pairResidualLines(fromResidual, toResidual).pairs,
    });
  }

  pairs.sort((p, q) => blockOrder(p.to, q.to));
  return {
    pairs,
    newBlocks: added.filter((a) => !consumedAdded.has(a)),
    deletedBlocks: removed.filter((r) => !consumedRemoved.has(r)),
  };
};

/* -------------------------------- net diff -------------------------------- */

/** Per-side cap for a focus line: two sides plus markup stay near 120 chars. */
const FOCUS_SIDE_CHARS = 49;

const trimFocusSide = (s: string): string =>
  s.length <= FOCUS_SIDE_CHARS ? s : `${s.slice(0, 23)}...${s.slice(-23)}`;

/** The compact focus lines of a residual region, one per token pair. */
const focusLines = (pairs: readonly ResidualPair[]): string[] =>
  pairs
    .filter((p) => p.edit.removedTokens.length > 0 || p.edit.addedTokens.length > 0)
    .map(
      (p) =>
        `real change: \`${trimFocusSide(p.edit.beforeContext)}\` -> \`${trimFocusSide(p.edit.afterContext)}\``,
    );

const renderRegion = (
  kind: RegionKind,
  file: string,
  startLine: number,
  lines: readonly string[],
  movedFrom?: NetRegion["movedFrom"],
  residualPairs?: readonly ResidualPair[],
): string => {
  const label =
    kind === "new"
      ? "new"
      : kind === "deletion"
        ? "deleted"
        : `edit inside code moved from ${movedFrom?.file ?? "?"}:${movedFrom?.startLine ?? 0}, similarity ${(movedFrom?.similarity ?? 0).toFixed(2)}`;
  const marker = kind === "deletion" ? "-" : "+";
  return [
    `=== ${file}:${startLine} (${label})`,
    ...lines.map((l) => `${marker}${l}`),
    ...focusLines(residualPairs ?? []),
  ].join("\n");
};

const regionOrder = (a: NetRegion, b: NetRegion): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine;

/** Detected whole-file moves must cover this share of the old file's lines. */
const RENAME_COVERAGE = 0.9;

/**
 * The genuinely-new content of a diff, after moves are factored out:
 * new blocks, residual edits inside moved blocks, and outright deletions.
 * Stats reconstruct the gross counts exactly:
 * grossAdded = movedAdded + residualAdded + newLines and
 * grossRemoved = movedRemoved + residualRemoved + deletedLines.
 */
export const computeNetDiff = (
  deltas: readonly FileDelta[],
  moves: MoveReport,
): NetDiff => {
  let grossAdded = 0;
  let grossRemoved = 0;
  for (const d of deltas) {
    for (const h of d.hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") grossAdded++;
        else if (l.kind === "del") grossRemoved++;
      }
    }
  }

  const regions: NetRegion[] = [];
  for (const b of moves.newBlocks) {
    regions.push({
      kind: "new",
      file: b.file,
      startLine: b.startLine,
      lines: b.lines,
      content: renderRegion("new", b.file, b.startLine, b.lines),
    });
  }
  let residualAdded = 0;
  let residualRemoved = 0;
  let movedAdded = 0;
  let movedRemoved = 0;
  for (const p of moves.pairs) {
    movedAdded += p.to.lines.length - p.toResidual.length;
    movedRemoved += p.from.lines.length - p.fromResidual.length;
    residualAdded += p.toResidual.length;
    residualRemoved += p.fromResidual.length;
    if (p.toResidual.length === 0) continue;
    const movedFrom = {
      file: p.from.file,
      startLine: p.from.startLine,
      similarity: p.similarity,
    };
    regions.push({
      kind: "residual",
      file: p.to.file,
      startLine: p.to.startLine,
      lines: p.toResidual,
      movedFrom,
      residualPairs: p.residualPairs,
      content: renderRegion(
        "residual",
        p.to.file,
        p.to.startLine,
        p.toResidual,
        movedFrom,
        p.residualPairs,
      ),
    });
  }
  let deletedLines = 0;
  for (const b of moves.deletedBlocks) {
    deletedLines += b.lines.length;
    regions.push({
      kind: "deletion",
      file: b.file,
      startLine: b.startLine,
      lines: b.lines,
      content: renderRegion("deletion", b.file, b.startLine, b.lines),
    });
  }
  regions.sort(regionOrder);

  const newLines = moves.newBlocks.reduce((n, b) => n + b.lines.length, 0);
  const netLines = newLines + residualAdded;
  const gross = grossAdded + grossRemoved;
  const movePct = gross === 0 ? 0 : Math.round(((movedAdded + movedRemoved) / gross) * 100);
  const netChars = regions.reduce((n, r) => n + r.content.length, 0);

  // rename candidates: what git already marked, plus detected whole-file moves
  const renameCandidates: RenameCandidate[] = [];
  const seenRename = new Set<string>();
  const pushRename = (c: RenameCandidate) => {
    const key = `${c.from} ${c.to}`;
    if (seenRename.has(key)) return;
    seenRename.add(key);
    renameCandidates.push(c);
  };
  for (const d of deltas) {
    if (d.status !== "renamed" || d.oldPath === null || d.newPath === null) continue;
    let edited = 0;
    for (const h of d.hunks) for (const l of h.lines) if (l.kind === "add") edited++;
    pushRename({ from: d.oldPath, to: d.newPath, editedLines: edited });
  }
  const deletedFiles = new Map<string, number>();
  for (const d of deltas) {
    if (d.status !== "deleted" || d.oldPath === null) continue;
    let removedTotal = 0;
    for (const h of d.hunks) for (const l of h.lines) if (l.kind === "del") removedTotal++;
    deletedFiles.set(d.oldPath, removedTotal);
  }
  const addedFiles = new Set<string>();
  for (const d of deltas) {
    if (d.status === "added" && d.newPath !== null) addedFiles.add(d.newPath);
  }
  const byFilePair = new Map<string, { matched: number; edited: number; from: string; to: string }>();
  for (const p of moves.pairs) {
    if (!deletedFiles.has(p.from.file) || !addedFiles.has(p.to.file)) continue;
    const key = `${p.from.file} ${p.to.file}`;
    const entry =
      byFilePair.get(key) ?? { matched: 0, edited: 0, from: p.from.file, to: p.to.file };
    entry.matched += p.from.lines.length - p.fromResidual.length;
    entry.edited += p.toResidual.length;
    byFilePair.set(key, entry);
  }
  for (const entry of byFilePair.values()) {
    const oldTotal = deletedFiles.get(entry.from) ?? 0;
    if (oldTotal > 0 && entry.matched >= RENAME_COVERAGE * oldTotal) {
      pushRename({ from: entry.from, to: entry.to, editedLines: entry.edited });
    }
  }
  renameCandidates.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );

  return {
    regions,
    stats: {
      grossAdded,
      grossRemoved,
      movedAdded,
      movedRemoved,
      residualAdded,
      residualRemoved,
      newLines,
      deletedLines,
      netLines,
      movePct,
      netChars,
    },
    renameCandidates,
    moves,
  };
};

/* ------------------------------ move summary ------------------------------ */

/**
 * The one-paragraph move summary a lane prompt carries above the net diff.
 * Plain STYLE.md copy, fully determined by the stats.
 */
export const describeMoves = (net: NetDiff): string => {
  const s = net.stats;
  const gross = s.grossAdded + s.grossRemoved;
  const parts: string[] = [];
  parts.push(
    `This diff changes ${gross} lines gross (${s.grossAdded} added, ${s.grossRemoved} removed).`,
  );
  if (s.movedAdded + s.movedRemoved > 0) {
    parts.push(
      `${s.movedAdded + s.movedRemoved} of those lines (${s.movePct}%) are code moved without edit, factored out below.`,
    );
  } else {
    parts.push("No moved code was detected.");
  }
  const edits = net.moves.pairs.filter((p) => p.kind === "move_with_edit").length;
  if (edits > 0) {
    parts.push(
      `${edits} moved ${edits === 1 ? "block carries" : "blocks carry"} edits: ${s.residualAdded} residual new ${s.residualAdded === 1 ? "line" : "lines"} shown below.`,
    );
  }
  if (net.renameCandidates.length > 0) {
    const names = net.renameCandidates
      .slice(0, 5)
      .map((r) => `${r.from} to ${r.to}${r.editedLines > 0 ? ` (${r.editedLines} edited)` : ""}`)
      .join("; ");
    parts.push(`${net.renameCandidates.length} whole-file ${net.renameCandidates.length === 1 ? "move" : "moves"}: ${names}.`);
  }
  parts.push(
    `Net content to review: ${s.newLines} new ${s.newLines === 1 ? "line" : "lines"}, ${s.residualAdded} residual ${s.residualAdded === 1 ? "edit" : "edits"}, ${s.deletedLines} deleted ${s.deletedLines === 1 ? "line" : "lines"}.`,
  );
  return parts.join(" ");
};

/* ------------------------------ review plan ------------------------------- */

/** Paths where a small edit carries outsized risk. */
const HIGH_RISK_PATH =
  /auth|token|secret|crypt|sign|payment|billing|wallet|permission|password|credential|escrow|payout/i;
const CONFIG_PATH =
  /(^|\/)config|\.ya?ml$|\.toml$|\.env|dockerfile|\/workflows\/|migration|schema|\.sql$/i;

const riskMultiplier = (file: string): number =>
  HIGH_RISK_PATH.test(file) ? 3 : CONFIG_PATH.test(file) ? 2 : 1;

/** Edits hidden inside moved blocks are where regressions hide; deletions rank last. */
const kindMultiplier = (kind: RegionKind): number =>
  kind === "residual" ? 2 : kind === "new" ? 1 : 0.75;

/**
 * Review value per line of budget. Value grows with risk, kind, and log of
 * size; dividing by line count means a one-line auth guard outranks a
 * thousand generated table rows, so tight budgets spend on risk first. Lines
 * are the denominator, not rendered chars: the region header is metadata and
 * must not tax small regions.
 */
const regionScore = (r: NetRegion): number =>
  (riskMultiplier(r.file) * kindMultiplier(r.kind) * (1 + Math.log2(1 + r.lines.length))) /
  (1 + r.lines.length);

/** Keep a truncated tail region only when at least this much budget remains. */
const MIN_TRUNCATED_CHARS = 512;

/**
 * Rank the net regions and pack them into the char budget.
 * Rank: review value per char, where value is path risk (auth, payment,
 * config patterns) x kind (residual edits first, then new code, then
 * deletions) x log-scaled size. Deterministic tie-break on file then line.
 * Packing is greedy over the ranked list, whole regions first; when nothing
 * more fits whole and at least 512 chars remain, the best leftover is
 * truncated to fill the tail. Everything else is listed as unreviewed so the
 * lane can report net coverage honestly.
 */
export const planReview = (net: NetDiff, budgetChars: number): ReviewPlan => {
  const ranked = net.regions
    .map((r) => ({ region: r, score: regionScore(r) }))
    .sort((a, b) => b.score - a.score || regionOrder(a.region, b.region));

  const regions: PlannedRegion[] = [];
  const leftover: { region: NetRegion; score: number }[] = [];
  let packedChars = 0;
  for (const { region, score } of ranked) {
    const cost = region.content.length + 1; // joining newline
    if (packedChars + cost <= budgetChars) {
      regions.push({ ...region, score, truncated: false });
      packedChars += cost;
    } else {
      leftover.push({ region, score });
    }
  }
  const remaining = budgetChars - packedChars;
  if (leftover.length > 0 && remaining >= MIN_TRUNCATED_CHARS) {
    const head = leftover.shift();
    if (head) {
      const content = head.region.content.slice(0, remaining - 1);
      regions.push({ ...head.region, content, score: head.score, truncated: true });
      packedChars += content.length + 1;
    }
  }
  return {
    regions,
    unreviewed: leftover.map((l) => l.region),
    packedChars,
    totalNetChars: net.stats.netChars,
  };
};

/* ------------------------------- entry points ------------------------------ */

export interface DiffAnalysis {
  readonly deltas: readonly FileDelta[];
  readonly moves: MoveReport;
  readonly net: NetDiff;
  readonly plan: ReviewPlan;
}

/** The whole pipeline in one call: parse, detect moves, net, plan. */
export const analyzeDiff = (patch: string, budgetChars: number): DiffAnalysis => {
  const deltas = parseDiff(patch);
  const moves = detectMoves(deltas);
  const net = computeNetDiff(deltas, moves);
  return { deltas, moves, net, plan: planReview(net, budgetChars) };
};

/**
 * True when the patch parsed into at least one changed line, which is what
 * netting needs. Input that is not a unified diff (or lost its hunk headers)
 * cannot be netted: the lane must fall back to the raw text and the coverage
 * accounting must budget against its gross size. One rule, shared by the
 * prompt builder and the coverage math, so they can never disagree.
 */
export const isNettable = (analysis: {
  readonly deltas: readonly FileDelta[];
  readonly net: NetDiff;
}): boolean =>
  analysis.deltas.length > 0 &&
  analysis.net.stats.grossAdded + analysis.net.stats.grossRemoved > 0;

/**
 * The chars the coverage accounting should budget against: rendered net
 * content for a nettable patch, gross length for everything else.
 */
export const netDiffChars = (patch: string): number => {
  const analysis = analyzeDiff(patch, Number.MAX_SAFE_INTEGER);
  return isNettable(analysis) ? analysis.net.stats.netChars : patch.length;
};

/**
 * The diff as any lane sees it: net first. The deterministic pre-pass above
 * factors moved code out before the budget applies, so the whole prompt
 * budget goes to genuinely new content, residual edits inside moves, and
 * deletions, ranked by path risk. Coverage is therefore net coverage:
 * diffCoveragePercent over net chars, the same accounting run-review stamps
 * on the Understanding. Input that does not parse as a unified diff cannot
 * be netted and falls back to the raw slice against the gross budget.
 * Shared by every harness (CLI and HTTP lane) so their prompts and the
 * coverage math can never disagree.
 */
export const diffSection = (diff: string): string => {
  const analysis = analyzeDiff(diff, DIFF_BUDGET_CHARS);
  if (!isNettable(analysis)) {
    return `UNIFIED DIFF${diff.length > DIFF_BUDGET_CHARS ? ` (first ${DIFF_BUDGET_CHARS} of ${diff.length} chars)` : ""}:
${diff.slice(0, DIFF_BUDGET_CHARS)}`;
  }
  const { net, plan } = analysis;
  const coverage = diffCoveragePercent(net.stats.netChars);
  const missing = plan.unreviewed
    .slice(0, 20)
    .map((r) => `- ${r.file}:${r.startLine} (${r.kind}, ${r.lines.length} lines)`);
  const body = plan.regions.map((r) => r.content).join("\n");
  return `MOVE ANALYSIS (deterministic pre-pass, no model involved):
${describeMoves(net)}

NET DIFF, moves pre-factored${coverage < 100 ? ` (top regions by risk, ${coverage}% of the net content)` : ""}:
Each region below is content to actually review: new code, a residual edit inside a moved block, or a deletion. Moved code is already accounted for above and is not repeated here.
Inside a moved block, each "real change:" line names the exact tokens that changed, before -> after. Those tokens are the review target for that block. The rest of the block moved unchanged.
${body || "(no net content: every changed line is moved code)"}${
    missing.length > 0
      ? `

NOT SHOWN, over budget. Report these as unreviewed:
${missing.join("\n")}`
      : ""
  }`;
};
