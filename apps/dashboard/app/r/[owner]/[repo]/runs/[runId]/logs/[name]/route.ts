import { Effect } from "effect";
import { requireRepoAccess } from "@/lib/guard";
import { logKey, objectStore } from "@/lib/objects";
import { getRun } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves one stored log. The key is rebuilt from the run row's own list, never
 * from the URL, so a name that was never uploaded cannot reach the store.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ owner: string; repo: string; runId: string; name: string }> },
): Promise<Response> {
  const { owner, repo, runId, name } = await params;
  const { repo: row } = await requireRepoAccess(owner, repo);
  const run = await getRun(row.id, decodeURIComponent(runId));
  if (!run) return new Response("not found", { status: 404 });

  const wanted = logKey(run.id, decodeURIComponent(name));
  if (!run.logKeys.includes(wanted)) return new Response("not found", { status: 404 });

  const object = await Effect.runPromise(objectStore().get(wanted));
  if (!object) return new Response("not found", { status: 404 });

  // Uint8Array over a plain ArrayBuffer is what BodyInit accepts.
  return new Response(object.body.slice().buffer as ArrayBuffer, {
    headers: {
      "Content-Type": object.contentType,
      "Content-Disposition": `inline; filename="${decodeURIComponent(name)}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
