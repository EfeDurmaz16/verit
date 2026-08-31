import { Schema as S } from "effect";

/*
 * What a probe actually measures.
 *
 * The measured run ended with eleven fix-confirmed results out of twelve, which
 * is a suspiciously good number. A probe that opens a file and checks whether a
 * line is in it will fail on base and pass on head and prove nothing the diff
 * did not already show. It is a true result about a false question, and it
 * arrives looking exactly like evidence.
 *
 * So this is a third fact about a result, kept apart from the other two on
 * purpose. Classification says what the change did and comes from the two
 * outcomes. Grade says how independently that is corroborated. This says what
 * the probe was looking at, and it comes from reading the probe's own source.
 *
 * Deterministic, like everything else on this path. Asking a model whether its
 * own probe was rigorous is asking a question with one popular answer.
 */

export const AssertionKind = S.Literal("behavior", "text", "mixed", "unknown");
export type AssertionKind = S.Schema.Type<typeof AssertionKind>;

/*
 * Shell probes are common and they broke the first version of this: a bash
 * script that pulled the gate step out of action.yml and ran it came back
 * `unknown`, because every signal here was written for JavaScript.
 *
 * A shell script runs processes by definition, so the question is not whether
 * it spawns but what it spawns. `bash script.sh` runs the code under test.
 * `grep -q pattern file` reads it. Both are anchored to a command position so
 * that a word in a comment cannot promote a text probe out of its warning.
 */
// A command position: start of line, or after a separator, followed by any
// number of `VAR=value` prefixes, because `GITHUB_OUTPUT="$f" bash x.sh` is
// the shape these probes actually use to run the thing under test.
const ANCHOR = "(?:^|[\\n;&|(!]|\\$\\(|`|(?:then|do|else)\\s)[ \\t]*";
const ENV_PREFIX = "(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|[^\\s]*)[ \\t]+)*";
const CMD = `${ANCHOR}${ENV_PREFIX}`;
const shellCommand = (names: string): RegExp => new RegExp(`${CMD}(?:${names})\\s`, "m");

/** Starting a process, or calling the code, is exercising it. */
const BEHAVIOR_SIGNALS: readonly RegExp[] = [
  shellCommand("bash|sh|zsh|node|deno|bun|python3?|ruby|php|perl"),
  shellCommand("pnpm|npm|yarn|npx|cargo|go|make|dotnet|mvn|gradle"),
  // ./run.sh, scripts/x.py, /tmp/gate.sh. An extension is required because a
  // bare path matches `#!/usr/bin/env` and a `//` comment, and a signal that
  // fires on a shebang would quietly promote every text probe out of its warning.
  new RegExp(`${CMD}\\.{0,2}/[\\w./$-]*\\.(?:sh|bash|py|js|mjs|cjs|ts)\\b`, "m"),
  /\bspawnSync?\b/,
  /\bexecFileSync?\b/,
  /\bexecSync\b/,
  /child_process/,
  /\bsubprocess\b/,
  /\bsubprocess\.run\b/,
  /\bos\.system\b/,
  /\bBun\.spawn\b/,
  /Deno\.Command/,
  /\bawait\s+import\s*\(/,
  /\brequire\s*\(\s*["'`]\.{1,2}\//,
  /\bimport\s+.*\s+from\s+["'`]\.{1,2}\//,
  /\bfetch\s*\(/,
  /\bprocess\.exitCode\b/,
];

/** Opening a file and looking at the characters in it is reading, not running. */
const TEXT_SIGNALS: readonly RegExp[] = [
  shellCommand("grep|egrep|rg|awk|sed|cat|head|tail|jq|yq|cut|tr"),
  /readFileSync?\s*\(/,
  /\breadFile\s*\(/,
  /\bopen\s*\(.*\)\.read\b/,
  /fs\.read/,
  /\.includes\s*\(/,
  /\.indexOf\s*\(/,
  /\.match\s*\(/,
  /\btest\s*\(\s*(?:source|content|text|body|yml|yaml)\b/,
  /new RegExp\(/,
];

const hits = (source: string, patterns: readonly RegExp[]): number =>
  patterns.reduce((n, p) => (p.test(source) ? n + 1 : n), 0);

/**
 * What this probe is looking at, from its own source.
 *
 * `behavior` runs the thing. `text` reads the thing. `mixed` does both, which
 * is common and honest: a probe that starts a process and then greps its output
 * is exercising the code, and the grep is how it reads the answer. The
 * distinction that matters is whether the code under test ever ran, so a probe
 * with any real execution signal is never called `text`.
 *
 * `unknown` is not a hedge. It means the source has neither signal, which
 * usually means the probe does very little, and a reader should look at it.
 */
export const classifyAssertion = (source: string): AssertionKind => {
  if (source.trim() === "") return "unknown";
  const behavior = hits(source, BEHAVIOR_SIGNALS);
  const text = hits(source, TEXT_SIGNALS);
  if (behavior === 0 && text === 0) return "unknown";
  if (behavior === 0) return "text";
  if (text === 0) return "behavior";
  return "mixed";
};

/**
 * True when a result rests only on reading files.
 *
 * Kept as its own predicate rather than folded into the grade, because a text
 * check is not weakly corroborated, it is answering a different question. A
 * reader deserves to be told which one they are looking at.
 */
export const readsRatherThanRuns = (kind: AssertionKind): boolean => kind === "text";

/** The line the evidence body uses, in the reader's language rather than ours. */
export const describeAssertion = (kind: AssertionKind): string => {
  switch (kind) {
    case "behavior":
      return "ran the code";
    case "mixed":
      return "ran the code and read its output";
    case "text":
      return "read the file rather than running it, so it shows the source changed, not that behavior did";
    case "unknown":
      return "does neither obviously, worth reading before trusting";
  }
};
