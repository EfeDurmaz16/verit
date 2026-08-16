import { notFound, redirect } from "next/navigation";
import { canRead } from "./access";
import { repoBySlug, type RepoRow } from "./runs";
import { currentSession, type Session } from "./session";

/**
 * A dev session has no GitHub token, so there is nothing to check against.
 * It only exists when VERIT_DEV_USER names a login, which is never a
 * default, and it is the one path that skips the access check.
 */
export const allowed = async (session: Session, repoId: string): Promise<boolean> =>
  session.dev === true ? true : canRead(session.login, session.ghToken, repoId);

export const requireSession = async (): Promise<Session> => {
  const session = await currentSession();
  if (!session) redirect("/");
  return session;
};

/**
 * Every repo-scoped page goes through here. A repo the user may not read is a
 * 404, not a 403: the dashboard does not confirm that a private repo exists.
 */
export const requireRepoAccess = async (
  owner: string,
  name: string,
): Promise<{ session: Session; repo: RepoRow }> => {
  const session = await requireSession();
  const repo = await repoBySlug(`${owner}/${name}`);
  if (!repo) notFound();
  if (!(await allowed(session, repo.id))) notFound();
  return { session, repo };
};
