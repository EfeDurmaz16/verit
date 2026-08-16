import type { WikiPage } from "@verit/domain";
import { contentHash } from "./hash";

/** Split markdown into WikiPage nodes by ATX headings. */
export const markdownToWikiPages = (repoId: string, path: string, md: string): WikiPage[] => {
  const lines = md.split(/\r?\n/);
  const pages: WikiPage[] = [];
  let title = path.split("/").pop() ?? path;
  let body: string[] = [];
  let slug = "root";

  const flush = () => {
    const text = body.join("\n").trim();
    if (!text && pages.length === 0) return;
    const id = `wiki:${repoId}:${path}#${slug}`;
    pages.push({
      id,
      repoId,
      path: `${path}#${slug}`,
      title,
      body: text || "(empty)",
    });
  };

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      title = m[2]!.trim();
      slug = contentHash(title, 8);
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return pages.length > 0
    ? pages
    : [{ id: `wiki:${repoId}:${path}#root`, repoId, path, title, body: md }];
};
