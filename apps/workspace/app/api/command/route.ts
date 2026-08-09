import { runAgent, sseStream, SSE_HEADERS, watchBlocks } from "@/lib/codex";
import { commandPrompt } from "@/lib/prompt";
import { isWorkspaceDir } from "@/lib/sessions";
import { existsSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { threadId, workdir, command } = (await req.json()) as {
    threadId?: string;
    workdir?: string;
    command?: string;
  };
  if (!threadId || !workdir || !command) return new Response("missing fields", { status: 400 });
  // workdir must be one of our own session dirs — never an arbitrary path
  const normalized = path.resolve(workdir);
  if (!isWorkspaceDir(normalized) || !existsSync(normalized)) {
    return new Response("bad workdir", { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return new Response("bad thread id", { status: 400 });

  const stream = sseStream(async (send) => {
    // resume appends to the same blocks file — only forward what's new
    const watcher = watchBlocks(normalized, send, { fromEnd: true });
    await runAgent({
      cwd: normalized,
      prompt: commandPrompt(command.slice(0, 2000)),
      label: "command",
      lead: false,
      signal: req.signal,
      send,
    });
    await watcher.stop();
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
