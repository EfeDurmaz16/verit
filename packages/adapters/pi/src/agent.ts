import { spawnSync } from "node:child_process";
import { Either } from "effect";
import {
  decodeUnderstanding,
  OUTPUT_STYLE,
  UNDERSTANDING_JSON_SHAPE,
  type Understanding,
} from "@cyclops/domain";
import type { HarnessPort } from "@cyclops/ports";

/* Headless coding CLIs as the Action's Understanding source.

   The workspace lane streams: it spawns the CLI, watches it patch the
   workspace, and reads understanding.json off disk. The Action has no
   workspace to stream into, so it asks the same question once and reads one
   JSON object back. Different invocation, same contract: the shape comes from
   UNDERSTANDING_JSON_SHAPE and the answer goes through decodeUnderstanding. */

export type AgentCli = "claude" | "cursor";

type UnderstandInput = Parameters<HarnessPort["runUnderstand"]>[0];

/** Diff slice that fits one prompt and stays well under ARG_MAX on argv. */
const MAX_DIFF = 120_000;
const MAX_BODY = 8_000;
const DEFAULT_TIMEOUT_MS = 900_000;

interface CliSpec {
  readonly bin: string;
  readonly args: (prompt: string, model?: string) => string[];
  /** true when the prompt goes to stdin instead of argv */
  readonly promptOnStdin: boolean;
}

/* Flags verified against `claude --help` (2.1.219),
   https://code.claude.com/docs/en/headless , `cursor-agent --help`
   (2026.08.04) and https://cursor.com/docs/cli/reference/parameters .

   `--output-format json` returns a single object whose `result` holds the final
   assistant text, so no --verbose is needed here (that is a stream-json rule).
   No tool flags are passed: everything the model needs is already in the
   prompt, and print mode denies an unexpected tool call rather than blocking on
   a prompt nobody can answer. `--safe-mode` keeps the runner's CLAUDE.md,
   skills, hooks and MCP servers out of a review of someone else's PR. */
const CLI: Record<AgentCli, CliSpec> = {
  claude: {
    bin: "claude",
    args: (_prompt, model) => [
      "-p",
      "--output-format",
      "json",
      "--safe-mode",
      ...(model ? ["--model", model] : []),
    ],
    promptOnStdin: true,
  },
  cursor: {
    bin: "cursor-agent",
    args: (prompt, model) => [
      "-p",
      prompt,
      "--output-format",
      "json",
      ...(model ? ["--model", model] : []),
    ],
    promptOnStdin: false,
  },
};

const list = (items: readonly string[], max: number, empty: string): string =>
  items.length === 0 ? empty : items.slice(0, max).join("\n");

/** The one-shot Understanding request, OUTPUT_STYLE and contract included. */
export const agentPrompt = (input: UnderstandInput): string => {
  const { title, body, paths, diff, context, role } = input;
  const wiki = context.wiki_hits
    .slice(0, 3)
    .map((h) => `${h.title}: ${h.excerpt.slice(0, 120)}`);
  const neighbours = context.pr_graph
    .slice(0, 3)
    .map((n) => `#${n.number} ${n.title} (${n.edgeKind})`);

  return `You are the ${role} lane behind cyclops, a behaviour proof review tool.

Produce the Understanding of one pull request: what it changes, why, how a human can verify the behaviour, and where the risk is. Everything you need is below. Do not fetch anything.

TITLE: ${title}

DESCRIPTION:
${body.slice(0, MAX_BODY) || "(empty)"}

CHANGED PATHS (${paths.length}):
${list(paths, 200, "(none listed)")}

REVIEW CONTEXT: domain=${context.domain}, focus=${context.focus ?? "none"}
RELATED WIKI:
${list(wiki, 3, "(none indexed)")}
RELATED PULL REQUESTS:
${list(neighbours, 3, "(none)")}

UNIFIED DIFF${diff.length > MAX_DIFF ? ` (first ${MAX_DIFF} of ${diff.length} chars)` : ""}:
${diff.slice(0, MAX_DIFF)}

${OUTPUT_STYLE}

OUTPUT CONTRACT. Print ONE JSON object and nothing else: no prose, no code fence.
${UNDERSTANDING_JSON_SHAPE}
- Every file path and code excerpt must come verbatim from the diff above. Never invent one.`;
};

/**
 * Pull the Understanding object out of whatever the CLI printed.
 * In json mode both CLIs wrap the answer as `{"result":"<text>"}`, and the text
 * itself may carry a fence or a sentence in front of the object, so fall back
 * to the widest balanced object in the payload.
 */
export const extractUnderstanding = (stdout: string): unknown | null => {
  const raw = stdout.trim();
  if (!raw) return null;
  let body = raw;
  try {
    const wrapper: unknown = JSON.parse(raw);
    if (wrapper !== null && typeof wrapper === "object") {
      const result = (wrapper as { result?: unknown }).result;
      if (typeof result === "string") body = result;
      else if ("what" in wrapper) return wrapper;
    }
  } catch {
    /* not a wrapper: the CLI printed the object or some prose directly */
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
};

/** Spawn the CLI once. Returns null on any failure; the caller falls back. */
export const runAgentUnderstand = (
  cli: AgentCli,
  input: UnderstandInput,
): Understanding | null => {
  const spec = CLI[cli];
  const prompt = agentPrompt(input);
  const timeout = Number(process.env.CYCLOPS_LANE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const r = spawnSync(spec.bin, spec.args(prompt, process.env.CYCLOPS_LANE_MODEL), {
    input: spec.promptOnStdin ? prompt : undefined,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) {
    console.error(
      `[cyclops-${cli}] spawn failed status=${r.status} err=${r.error?.message ?? r.stderr?.slice(0, 400)}`,
    );
    return null;
  }
  const parsed = extractUnderstanding(r.stdout ?? "");
  if (parsed === null) {
    console.error(`[cyclops-${cli}] no JSON object in CLI output`);
    return null;
  }
  const decoded = decodeUnderstanding(parsed);
  if (Either.isLeft(decoded)) {
    console.error(`[cyclops-${cli}] Understanding decode failed`, decoded.left);
    return null;
  }
  return decoded.right;
};

/** The selector, shared with the workspace lane. */
export const agentCli = (value = process.env.CYCLOPS_LANE_HARNESS): AgentCli | null =>
  value === "claude" || value === "cursor" ? value : null;
