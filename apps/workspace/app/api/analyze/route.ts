import { SSE_HEADERS } from "@/lib/codex";
import { fetchPR, parsePrUrl } from "@/lib/gh";
import {
  attachStream,
  getLiveSession,
  replayEvents,
  replayStream,
  startSession,
} from "@/lib/sessions";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { url } = (await req.json()) as { url?: string };
  const parsed = parsePrUrl(url ?? "");
  if (!parsed) return new Response("bad pr url", { status: 400 });

  const pr = await fetchPR(parsed.repo, parsed.number);

  // in-flight (or just-finished) in this process, reattach, never restart
  const live = getLiveSession(pr);
  if (live) return new Response(attachStream(live), { headers: SSE_HEADERS });

  // finished on a previous server run, rehydrate from the store
  const replay = await replayEvents(pr);
  if (replay) return new Response(replayStream(replay), { headers: SSE_HEADERS });

  const session = await startSession(pr);
  return new Response(attachStream(session), { headers: SSE_HEADERS });
}
