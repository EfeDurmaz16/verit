import { requireRepoAccess } from "@/lib/guard";
import { exportOntologySqlite } from "@/lib/ontology";
import { loadOntologySnapshot } from "@/lib/ontology-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Your memory is yours." Exports one repo's whole ontology as a single SQLite
 * file that re-imports losslessly (see the round-trip test). Gated by the same
 * read access as every repo page: a repo the caller may not read is a 404.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  const { owner, repo } = await params;
  const { repo: row } = await requireRepoAccess(owner, repo);

  const snapshot = await loadOntologySnapshot(row.id);
  const bytes = exportOntologySqlite(snapshot);
  const filename = `${owner}-${repo}-ontology.db`;

  return new Response(bytes.slice().buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
