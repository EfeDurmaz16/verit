import { fetchPR, parsePrUrl } from "@/lib/gh";
import { stopSession } from "@/lib/sessions";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { url } = (await req.json()) as { url?: string };
  const parsed = parsePrUrl(url ?? "");
  if (!parsed) return NextResponse.json({ error: "bad pr url" }, { status: 400 });
  const pr = await fetchPR(parsed.repo, parsed.number);
  return NextResponse.json({ stopped: stopSession(pr) });
}
