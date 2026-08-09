import { parseDiff } from "@/lib/diff";
import { parsePrUrl } from "@/lib/gh";
import { fetchDiff } from "@/lib/prefetch";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") ?? "";
  const filePath = req.nextUrl.searchParams.get("path") ?? "";
  const parsed = parsePrUrl(url);
  if (!parsed || !filePath) return NextResponse.json({ error: "bad params" }, { status: 400 });
  try {
    const diff = await fetchDiff(parsed.repo, parsed.number);
    const hunks = parseDiff(diff).get(filePath) ?? [];
    return NextResponse.json({ hunks });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 300) : "diff failed" },
      { status: 502 },
    );
  }
}
