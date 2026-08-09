import { NextResponse } from "next/server";
import { randomState } from "@/lib/crypto";
import { STATE_COOKIE, cookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Step one of the login. The state is random per attempt and kept in a
 * short-lived httpOnly cookie, so a callback that did not start here is
 * rejected in step two.
 *
 * The `repo` scope is what lets the dashboard ask GitHub whether a signed-in
 * user may read a private repo. It is a coarse grant. A GitHub App would be
 * finer and is the upgrade path, see docs/dashboard-setup.md.
 */
export function GET(req: Request): NextResponse {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GITHUB_CLIENT_ID is not set" }, { status: 500 });
  }
  const state = randomState();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", new URL("/api/auth/callback", req.url).toString());
  url.searchParams.set("scope", "read:user read:org repo");
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set(STATE_COOKIE, state, cookieOptions(600));
  return res;
}
