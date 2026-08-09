import { query } from "./db";

export interface AccessRow {
  readonly canRead: boolean;
  readonly checkedAt: Date;
}

export const DEFAULT_TTL_SECONDS = 600;

export const ttlSeconds = (): number =>
  Number(process.env.CYCLOPS_ACCESS_TTL_SECONDS) || DEFAULT_TTL_SECONDS;

/**
 * A cached answer is trusted only inside its TTL. A clock that has moved
 * backwards, which happens on a resumed machine, counts as stale rather than
 * fresh forever: the check re-runs and costs one GitHub call.
 */
export const isFresh = (checkedAt: Date, now: Date, ttl: number): boolean => {
  const age = now.getTime() - checkedAt.getTime();
  return age >= 0 && age < ttl * 1000;
};

export interface AccessDeps {
  readonly readCache: (login: string, repoId: string) => Promise<AccessRow | null>;
  readonly writeCache: (
    login: string,
    repoId: string,
    canRead: boolean,
    at: Date,
  ) => Promise<void>;
  /** Asks GitHub whether this user can read this repo right now. */
  readonly verify: (login: string, repoId: string) => Promise<boolean>;
  readonly now: () => Date;
  readonly ttlSeconds: number;
}

/**
 * "May this user see this repo?" Answers from cache while the answer is fresh,
 * otherwise asks GitHub and writes the answer back. A no is cached too, so a
 * stranger clicking a link does not turn into a GitHub call per click.
 */
export const resolveAccess =
  (deps: AccessDeps) =>
  async (login: string, repoId: string): Promise<boolean> => {
    const cached = await deps.readCache(login, repoId);
    const now = deps.now();
    if (cached && isFresh(cached.checkedAt, now, deps.ttlSeconds)) return cached.canRead;
    const canRead = await deps.verify(login, repoId);
    await deps.writeCache(login, repoId, canRead, now);
    return canRead;
  };

const readCache = async (login: string, repoId: string): Promise<AccessRow | null> => {
  const rows = await query<{ can_read: boolean; checked_at: Date }>(
    `SELECT can_read, checked_at FROM repo_access WHERE user_login = $1 AND repo_id = $2`,
    [login, repoId],
  );
  const row = rows[0];
  return row ? { canRead: row.can_read, checkedAt: row.checked_at } : null;
};

const writeCache = async (
  login: string,
  repoId: string,
  canRead: boolean,
  at: Date,
): Promise<void> => {
  await query(
    `INSERT INTO repo_access (user_login, repo_id, can_read, checked_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_login, repo_id)
     DO UPDATE SET can_read = excluded.can_read, checked_at = excluded.checked_at`,
    [login, repoId, canRead, at],
  );
};

/** 200 means the token can read the repo. Anything else means it cannot. */
export const verifyOnGithub = async (token: string, repoId: string): Promise<boolean> => {
  const res = await fetch(`https://api.github.com/repos/${repoId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cyclops-dashboard",
    },
    cache: "no-store",
  });
  return res.status === 200;
};

/** The wired check: Postgres cache, GitHub as the source of truth. */
export const canRead = async (
  login: string,
  ghToken: string | null,
  repoId: string,
): Promise<boolean> => {
  if (ghToken === null) return false;
  return resolveAccess({
    readCache,
    writeCache,
    verify: (_login, id) => verifyOnGithub(ghToken, id),
    now: () => new Date(),
    ttlSeconds: ttlSeconds(),
  })(login, repoId);
};
