import { Effect } from "effect";
import { NextResponse } from "next/server";
import { authorizeIngest, bearerToken, parseUpload } from "@/lib/ingest";
import { logKey, objectStore } from "@/lib/objects";
import { repoBySlug, saveRun } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refuse a body before reading it. A run upload is prose and logs, not a disk image. */
const MAX_BYTES = 8 * 1024 * 1024;

const deny = () =>
  NextResponse.json({ error: "unknown repo or bad ingest token" }, { status: 401 });

/**
 * The Action posts a finished run here.
 *
 * Order matters. Authentication runs first, against the repo named in the
 * header, so an unauthenticated caller never learns anything from a validation
 * error. Only then is the body decoded against the @verit/domain schema.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const slug = req.headers.get("x-verit-repo");
  const token = bearerToken(req.headers.get("authorization"));
  if (!slug) return deny();

  const repo = await repoBySlug(slug);
  if (!authorizeIngest(repo, token)) return deny();

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json({ error: "run upload is too large" }, { status: 413 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ error: "run upload is too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const parsed = parseUpload(body, slug);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { upload } = parsed;
  const store = objectStore();
  const keys: string[] = [];
  for (const log of upload.logs ?? []) {
    const key = logKey(upload.run.id, log.name);
    await Effect.runPromise(store.put(key, log.body, log.contentType || "text/plain"));
    keys.push(key);
  }
  await saveRun(upload, keys);

  return NextResponse.json({
    ok: true,
    runId: upload.run.id,
    url: `/r/${upload.repo}/runs/${encodeURIComponent(upload.run.id)}`,
    logs: keys.length,
  });
}
