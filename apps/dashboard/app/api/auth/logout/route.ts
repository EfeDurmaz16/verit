import { NextResponse } from "next/server";
import { SESSION_COOKIE, cookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): NextResponse {
  const res = NextResponse.redirect(new URL("/", req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  return res;
}
