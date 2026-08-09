import { SSE_HEADERS, sseStream } from "@/lib/codex";
import { fetchPR, parsePrUrl } from "@/lib/gh";
import { prefetchPR, readCache } from "@/lib/prefetch";
import { buildShellSpec } from "@/lib/shell-spec";
import { attachStream, getSession, startSession } from "@/lib/sessions";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { url } = (await req.json()) as { url?: string };
  const parsed = parsePrUrl(url ?? "");
  if (!parsed) return new Response("bad pr url", { status: 400 });

  const pr = await fetchPR(parsed.repo, parsed.number);

  // an in-flight or finished session for this head — reattach, never restart
  const existing = getSession(pr);
  if (existing) {
    return new Response(attachStream(existing), { headers: SSE_HEADERS });
  }

  // completed on a previous server run — instant replay from disk
  const cached = await readCache(pr);
  if (cached) {
    const shell = buildShellSpec(pr);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lattice-"));
    const stream = sseStream(async (send) => {
      void prefetchPR(pr, cwd).catch(() => {}); // command lane expects data files
      for (const line of shell.lines) send({ kind: "patch", line });
      send({ kind: "activity", text: `replayed from cache (${pr.headSha.slice(0, 7)})` });
      for (const line of cached.lines) send({ kind: "patch", line });
      send({
        kind: "patch",
        line: JSON.stringify({ op: "remove", path: "/elements/ws/children/0" }),
      });
      if (cached.threadId)
        send({ kind: "session", threadId: cached.threadId, workdir: cwd });
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  const session = await startSession(pr);
  return new Response(attachStream(session), { headers: SSE_HEADERS });
}
