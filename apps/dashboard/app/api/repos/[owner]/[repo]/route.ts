import { NextResponse } from "next/server";
import { requireRepoAccess } from "@/lib/guard";
import { objectStore } from "@/lib/objects";
import { deleteRepoData } from "@/lib/repo-delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Erases a repo's run history: every run row and every stored blob for
 * {owner}/{repo}. The human view lives at `/r/{owner}/{repo}`, which is a page,
 * so the erase verb hangs off the API tree at the same slug.
 *
 * Authorized exactly like reading a run, through requireRepoAccess: a caller
 * who may not read the repo gets the same 404 a stranger gets and never learns
 * the repo exists.
 *
 * ponytail: read access authorizes deletion, matching the existing run-read
 * auth as specced. Tighten to push/admin access if erasure needs to outrank
 * viewing.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<NextResponse> {
  const { owner, repo } = await params;
  const { repo: row } = await requireRepoAccess(owner, repo);
  const report = await deleteRepoData(row.id, objectStore());
  return NextResponse.json({ ok: true, repo: row.id, ...report });
}
