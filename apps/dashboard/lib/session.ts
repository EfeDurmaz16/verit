import { cookies } from "next/headers";
import { open, seal } from "./crypto";

export const SESSION_COOKIE = "verit_session";
export const STATE_COOKIE = "verit_oauth_state";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Session {
  readonly login: string;
  readonly userId: number;
  /** The user's GitHub token, used only to ask GitHub what they may read. */
  readonly ghToken: string | null;
  /** Unix seconds. */
  readonly exp: number;
  /** True for a VERIT_DEV_USER session, which never sees GitHub. */
  readonly dev?: boolean;
}

const isSession = (v: unknown): v is Session => {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.login === "string" &&
    s.login.length > 0 &&
    typeof s.userId === "number" &&
    (s.ghToken === null || typeof s.ghToken === "string") &&
    typeof s.exp === "number"
  );
};

/** Decodes a sealed cookie. Returns null for a forged, corrupt or expired one. */
export const parseSession = (sealed: string | undefined, nowSeconds: number): Session | null => {
  if (!sealed) return null;
  const json = open(sealed);
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isSession(parsed) || parsed.exp <= nowSeconds) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const sealSession = (s: Session): string => seal(JSON.stringify(s));

export const cookieOptions = (maxAge: number) =>
  ({
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  }) as const;

/**
 * The local shortcut. It exists only when VERIT_DEV_USER names a login, and
 * there is no default: with the variable unset the dashboard always asks GitHub
 * who you are. A dev session carries no GitHub token, so it is also the reason
 * the dev path grants repo access without an access check.
 */
export const devSession = (): Session | null => {
  const login = process.env.VERIT_DEV_USER;
  if (!login) return null;
  return {
    login,
    userId: 0,
    ghToken: null,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    dev: true,
  };
};

export const currentSession = async (): Promise<Session | null> => {
  const dev = devSession();
  if (dev) return dev;
  const jar = await cookies();
  return parseSession(jar.get(SESSION_COOKIE)?.value, Math.floor(Date.now() / 1000));
};
