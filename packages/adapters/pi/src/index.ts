import { spawnSync } from "node:child_process";
import { Either } from "effect";
import { Effect } from "effect";
import { decodeUnderstanding, type Understanding } from "@verit/domain";
import type { HarnessPort } from "@verit/ports";
import { StoreError } from "@verit/ports";
import { agentCli, runAgentUnderstand } from "./agent";

type UnderstandInput = Parameters<HarnessPort["runUnderstand"]>[0];

const section = (body: string, name: string): string => {
  const re = new RegExp(
    `(?:^|\\n)#{1,3}\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n---|\\s*$)`,
    "i",
  );
  return re.exec(body)?.[1]?.trim() ?? "";
};

const bullets = (block: string): string[] =>
  block
    .split(/\n/)
    .map((l) => /^\s*[-*]\s*(?:\[.\]\s*)?(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => Boolean(x));

/** Deterministic Understanding from ReviewContext + PR metadata (no model). */
export const buildDeterministicUnderstanding = (input: UnderstandInput): Understanding => {
  const { title, body, paths, diff, context, role } = input;
  const pathPreview = paths.slice(0, 10).join(", ") || "(no paths listed)";
  const summaryBullets = bullets(section(body, "(?:Summary|Motivation|Description)"));
  const bodyLead =
    summaryBullets.slice(0, 3).join("; ") ||
    body
      .trim()
      .split(/\n\n/)
      .map((p) => p.trim())
      .map((p) => p.replace(/^#{1,6}\s+.*$/gm, "").trim())
      .map((p) => p.replace(/<!--[\s\S]*?-->/g, "").trim())
      .find((p) => p.length > 20);

  const wiki =
    context.wiki_hits.length > 0
      ? context.wiki_hits
          .slice(0, 3)
          .map((h) => `${h.title}: ${h.excerpt.slice(0, 80)}`)
          .join(" | ")
      : "none indexed";
  const neighbors =
    context.pr_graph.length > 0
      ? context.pr_graph
          .slice(0, 3)
          .map((n) => `#${n.number} ${n.title} (${n.edgeKind})`)
          .join("; ")
      : "none";

  const testPlan = bullets(section(body, "(?:Test plan|Testing|Tests)"));
  const authorRisks = extractAuthorRiskHints(body);

  const proof_refs: Understanding["proof_refs"] = [
    {
      kind: "command",
      label: "diff-stats",
      value: `chars=${diff.length}; paths=${paths.length}`,
    },
    ...testPlan.slice(0, 5).map((cmd) => ({
      kind: "command" as const,
      label: "test-plan",
      value: cmd,
    })),
    ...paths.slice(0, 3).map((p) => ({
      kind: "url" as const,
      label: "changed-path",
      value: p,
    })),
  ];

  return {
    what: title.trim() || `Untitled ${role} change (${context.domain})`,
    why:
      (bodyLead ?? "").slice(0, 500) ||
      `PR affects ${context.domain}${context.focus ? ` with focus ${context.focus}` : ""}. Stub derived why from empty body.`,
    how: [
      `Paths (${paths.length}): ${pathPreview}.`,
      `Diff length ${diff.length} chars.`,
      `Wiki hits: ${wiki}.`,
      `PR graph: ${neighbors}.`,
    ].join(" "),
    proof_refs,
    out_of_scope: [
      "Model-authored behavioral proof (Pi binary not used or failed)",
      "Executable sandbox verification",
    ],
    risks: [
      ...authorRisks,
      {
        area: "harness",
        note:
          process.env.VERIT_PI_BIN != null
            ? "VERIT_PI_BIN set but stub path active (spawn failed or returned invalid JSON)."
            : "VERIT_PI_BIN unset. Using deterministic stub Understanding.",
        source: "reviewer",
      },
    ],
  };
};

const extractAuthorRiskHints = (body: string): Array<{ area: string; note: string; source: "author" }> => {
  const risks: Array<{ area: string; note: string; source: "author" }> = [];
  for (const line of bullets(section(body, "Risks?"))) {
    risks.push({ area: "author-hint", note: line, source: "author" });
  }
  for (const line of bullets(section(body, "(?:Breaking changes?)"))) {
    risks.push({ area: "breaking", note: line, source: "author" });
  }
  if (risks.length === 0 && /breaking\s+change/i.test(body)) {
    risks.push({
      area: "compat",
      note: "PR body mentions a breaking change (author hint).",
      source: "author",
    });
  }
  return risks;
};

const trySpawnPi = (input: UnderstandInput): Understanding | null => {
  const bin = process.env.VERIT_PI_BIN;
  if (!bin) return null;
  const payload = JSON.stringify({
    verb: "understand",
    role: input.role,
    title: input.title,
    body: input.body,
    paths: input.paths,
    diff: input.diff,
    context: input.context,
  });
  const args = (process.env.VERIT_PI_ARGS ?? "understand --json").split(/\s+/).filter(Boolean);
  const r = spawnSync(bin, args, {
    input: payload,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    console.error(
      `[verit-pi] spawn failed status=${r.status} err=${r.error?.message ?? r.stderr?.slice(0, 400)}`,
    );
    return null;
  }
  const raw = (r.stdout ?? "").trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const line = raw
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .at(-1);
    if (!line) return null;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
  }
  const decoded = decodeUnderstanding(parsed);
  if (Either.isLeft(decoded)) {
    console.error("[verit-pi] Understanding decode failed", decoded.left);
    return null;
  }
  return decoded.right;
};

/**
 * Pi harness adapter.
 * - If `VERIT_PI_BIN` is set, spawn that binary with JSON stdin (`VERIT_PI_ARGS`, default `understand --json`).
 * - Otherwise (or on spawn/decode failure) return a high-quality deterministic stub from ReviewContext.
 */
export const makePiHarness = (): HarnessPort => ({
  runUnderstand: (input) =>
    Effect.try({
      try: () => trySpawnPi(input) ?? buildDeterministicUnderstanding(input),
      catch: (e) => new StoreError("pi harness understand", e),
    }),
});

/**
 * Harness for the CLI and Action path, with the same selector the workspace
 * lane uses. `VERIT_LANE_HARNESS=claude|cursor` asks that CLI for the
 * Understanding; anything else keeps Pi.
 *
 * Every failure degrades instead of throwing: no API key, no CLI on PATH, a
 * timeout, or output that misses the schema all fall through to Pi and then to
 * the deterministic stub. That is deliberate. CI without the key must keep
 * producing exactly what it produces today.
 */
export const makeAgentHarness = (): HarnessPort => ({
  runUnderstand: (input) =>
    Effect.try({
      try: () => {
        const cli = agentCli();
        const live = cli ? runAgentUnderstand(cli, input) : null;
        return live ?? trySpawnPi(input) ?? buildDeterministicUnderstanding(input);
      },
      catch: (e) => new StoreError("agent harness understand", e),
    }),
});

export { agentCli, agentPrompt, extractUnderstanding, runAgentUnderstand } from "./agent";
export type { AgentCli } from "./agent";
