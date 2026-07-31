import type { IndexChunk, WikiPage } from "@cyclops/domain";
import { contentHash } from "./hash.js";

/** Split text into overlapping IndexChunk rows for FTS / retrieval. */
export const chunkText = (
  repoId: string,
  sourceKind: IndexChunk["sourceKind"],
  sourceId: string,
  text: string,
  maxChars = 800,
): IndexChunk[] => {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const chunks: IndexChunk[] = [];
  let offset = 0;
  let i = 0;
  while (offset < cleaned.length) {
    const slice = cleaned.slice(offset, offset + maxChars);
    const id = `chunk:${sourceId}:${contentHash(`${i}:${slice}`, 12)}`;
    chunks.push({
      id,
      repoId,
      sourceKind,
      sourceId,
      text: slice,
    });
    i++;
    if (offset + maxChars >= cleaned.length) break;
    offset += Math.floor(maxChars * 0.75);
  }
  return chunks;
};

export const wikiPagesToChunks = (pages: readonly WikiPage[]): IndexChunk[] =>
  pages.flatMap((p) =>
    chunkText(p.repoId, "wiki", p.id, `${p.title}\n\n${p.body}`),
  );
