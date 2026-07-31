import type { PrGraphNeighbor, ReviewContext, WikiHit, WikiPage, PREdge, PullRequest } from "@cyclops/domain";
import type { ReviewDomain } from "@cyclops/domain";

export const buildWikiHits = (pages: readonly WikiPage[], q: string, limit = 5): WikiHit[] => {
  const needle = q.toLowerCase();
  return pages
    .map((p) => {
      const hay = `${p.title}\n${p.body}`.toLowerCase();
      const score = needle.length === 0 ? 0.1 : (hay.includes(needle) ? 1 : 0) + (p.title.toLowerCase().includes(needle) ? 0.5 : 0);
      const idx = hay.indexOf(needle);
      const excerpt =
        needle.length === 0
          ? p.body.slice(0, 160)
          : idx >= 0
            ? p.body.slice(Math.max(0, idx - 40), idx + needle.length + 80)
            : p.body.slice(0, 120);
      return { pageId: p.id, title: p.title, excerpt, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

export const buildPrGraph = (
  edges: readonly PREdge[],
  prs: readonly PullRequest[],
): PrGraphNeighbor[] => {
  const byId = new Map(prs.map((p) => [p.id, p]));
  return edges.map((e) => {
    const otherId = e.fromPrId;
    const pr = byId.get(e.toPrId) ?? byId.get(e.fromPrId);
    return {
      prId: e.toPrId === otherId ? e.fromPrId : e.toPrId,
      number: pr?.number ?? 0,
      title: pr?.title ?? "(unknown)",
      edgeKind: e.kind,
      inferred: e.inferred,
      blurb: `${e.kind}${e.inferred ? " (inferred)" : ""}`,
    };
  });
};

export const buildReviewContext = (input: {
  pages: readonly WikiPage[];
  query: string;
  edges: readonly PREdge[];
  prs: readonly PullRequest[];
  domain: ReviewDomain;
  focus?: ReviewDomain;
}): ReviewContext => ({
  wiki_hits: buildWikiHits(input.pages, input.query),
  pr_graph: buildPrGraph(input.edges, input.prs),
  domain: input.domain,
  focus: input.focus,
});
