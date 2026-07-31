import type { PREdge, PullRequest } from "@cyclops/domain";
import { contentHash } from "./hash.js";

export { contentHash };

const pathGlobOverlap = (a: readonly string[], b: readonly string[]): boolean => {
  // Top-level directory (or file basename if unscoped) — shared path glob for edge (b).
  const dirs = (paths: readonly string[]) =>
    new Set(paths.map((p) => p.split("/")[0] ?? p));
  const A = dirs(a);
  for (const d of dirs(b)) if (A.has(d)) return true;
  return false;
};

const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / (86400 * 1000);

/** Inferred edge (b): same author + shared path glob within 14 days. */
export const inferSameAuthorPathEdges = (
  current: PullRequest & { changedPaths: readonly string[]; updatedAt: string },
  others: readonly (PullRequest & { changedPaths: readonly string[]; updatedAt: string })[],
): PREdge[] => {
  const out: PREdge[] = [];
  for (const o of others) {
    if (o.id === current.id) continue;
    if (o.author !== current.author) continue;
    if (daysBetween(current.updatedAt, o.updatedAt) > 14) continue;
    if (!pathGlobOverlap(current.changedPaths, o.changedPaths)) continue;
    out.push({
      id: `edge:same_author_path:${current.id}:${o.id}`,
      fromPrId: current.id,
      toPrId: o.id,
      kind: "same_author_path",
      inferred: true,
      confidence: 0.7,
    });
  }
  return out;
};

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/** Cheap bag-of-chars embedding for dogfood until real embedder is wired. */
export const cheapEmbed = (text: string): number[] => {
  const v = new Array<number>(32).fill(0);
  for (let i = 0; i < text.length; i++) {
    const idx = text.charCodeAt(i) % 32;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};

/** Inferred edge (c): embedding similarity on title+body. */
export const inferEmbeddingSimilarEdges = (
  current: PullRequest,
  others: readonly PullRequest[],
  threshold = 0.85,
): PREdge[] => {
  const cur = cheapEmbed(`${current.title}\n${current.body ?? ""}`);
  const out: PREdge[] = [];
  for (const o of others) {
    if (o.id === current.id) continue;
    const sim = cosine(cur, cheapEmbed(`${o.title}\n${o.body ?? ""}`));
    if (sim < threshold) continue;
    out.push({
      id: `edge:embed:${current.id}:${o.id}`,
      fromPrId: current.id,
      toPrId: o.id,
      kind: "embedding_similar",
      inferred: true,
      confidence: sim,
    });
  }
  return out;
};
