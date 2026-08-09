import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_COOKIE,
  cookieOptions,
  sealSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sameState = (a: string | undefined, b: string | null): boolean => {
  if (!a || !b) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

const fail = (req: Request, reason: string): NextResponse =>
  NextResponse.redirect(new URL(`/?login=${encodeURIComponent(reason)}`, req.url));

/** Step two: swap the code for a token, read who the user is, seal a session. */
export async function GET(req: Request): Promise<NextResponse> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(req, "not-configured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = req.headers
    .get("cookie")
    ?.split("; ")
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);
  if (!code) return fail(req, "no-code");
  if (!sameState(expected, state)) return fail(req, "bad-state");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: new URL("/api/auth/callback", req.url).toString(),
    }),
    cache: "no-store",
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  const ghToken = tokenBody.access_token;
  if (!ghToken) return fail(req, "no-token");

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cyclops-dashboard",
    },
    cache: "no-store",
  });
  if (!userRes.ok) return fail(req, "no-user");
  const user = (await userRes.json()) as { login?: string; id?: number };
  if (!user.login || typeof user.id !== "number") return fail(req, "no-user");

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(
    SESSION_COOKIE,
    sealSession({
      login: user.login,
      userId: user.id,
      ghToken,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
    cookieOptions(SESSION_TTL_SECONDS),
  );
  res.cookies.set(STATE_COOKIE, "", cookieOptions(0));
  return res;
}
