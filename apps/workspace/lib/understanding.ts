import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeUnderstanding, type Understanding } from "@verit/domain";
import { Either } from "effect";

/* The analysis lane's machine-readable output contract. Everything the lane
   streams into the workspace is a draft; this file is what gets validated
   against the verit Understanding schema and persisted. */

export const UNDERSTANDING_FILE = "understanding.json";

/* Element keys the lane streams into and the server overwrites with the
   validated values. Same keys, so the canonical render replaces the draft
   in place instead of stacking a second copy next to it. */
const KEY = {
  what: "u-what",
  how: "u-how",
  proof: "u-proof",
  risks: "u-risks",
  scope: "u-scope",
} as const;

export const SECTION = {
  understanding: "sec-understanding",
  proof: "sec-proof",
  risks: "sec-risks",
  scope: "sec-out-of-scope",
} as const;

export type ReadResult =
  | { ok: true; understanding: Understanding }
  | { ok: false; error: string };

/** Read + schema-validate the lane's Understanding. Never throws. */
export async function readUnderstanding(cwd: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(path.join(cwd, UNDERSTANDING_FILE), "utf8");
  } catch {
    return { ok: false, error: `lane produced no ${UNDERSTANDING_FILE}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `${UNDERSTANDING_FILE} is not valid JSON: ${msg(e)}` };
  }
  const decoded = decodeUnderstanding(parsed);
  if (Either.isLeft(decoded)) {
    return { ok: false, error: `Understanding failed schema validation: ${msg(decoded.left)}` };
  }
  return { ok: true, understanding: decoded.right };
}

const msg = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 400);

const add = (p: string, value: unknown): string =>
  JSON.stringify({ op: "add", path: p, value });

const el = (key: string, type: string, props: Record<string, unknown>): string =>
  add(`/elements/${key}`, { type, props, children: [] });

/* Attaching an already-present key is safe: the client dedupes children. */
const attach = (section: string, key: string): string =>
  add(`/elements/${section}/children/-`, key);

/**
 * Deterministic SpecStream render of a validated Understanding.
 * Author risks stay visually separate from reviewer risks. Author hints are
 * never presented as the complete risk set.
 */
export function understandingPatches(u: Understanding): string[] {
  const lines = [
    el(KEY.what, "Summary", { headline: u.what, body: u.why }),
    attach(SECTION.understanding, KEY.what),
    el(KEY.how, "Text", { content: u.how }),
    attach(SECTION.understanding, KEY.how),
    // whole refs, not a projection: an executed ref's verdict and log tail are
    // the evidence, and dropping them would render a failed proof as neutral
    el(KEY.proof, "ProofEvidence", { refs: u.proof_refs }),
    attach(SECTION.proof, KEY.proof),
    el(KEY.risks, "RisksList", {
      authorDeclared: u.risks.filter((r) => r.source !== "reviewer"),
      reviewerFound: u.risks.filter((r) => r.source === "reviewer"),
    }),
    attach(SECTION.risks, KEY.risks),
  ];
  const scope = u.out_of_scope ?? [];
  if (scope.length > 0) {
    lines.push(
      el(KEY.scope, "Text", {
        content: scope.map((s) => `• ${s}`).join("\n"),
        tone: "muted",
      }),
      attach(SECTION.scope, KEY.scope),
    );
  }
  return lines;
}
