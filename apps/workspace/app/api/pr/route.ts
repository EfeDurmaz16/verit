import { fetchPR, parsePrUrl } from "@/lib/gh";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") ?? "";
  const parsed = parsePrUrl(url);
  if (!parsed) {
    return NextResponse.json(
      { error: "Expected a GitHub PR URL like https://github.com/owner/repo/pull/123" },
      { status: 400 },
    );
  }
  try {
    const pr = await fetchPR(parsed.repo, parsed.number);
    return NextResponse.json(pr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 500) }, { status: 502 });
  }
}
