import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { laneAdapter } from "./harness";
import type { StreamEvent } from "./schema";

/* Headless lane plumbing: N parallel coding-CLI lanes append SpecStream lines
   to one blocks.ndjson; a single watcher tails the file; each lane's stdout
   JSONL provides activity/session events. Which CLI runs is harness.ts's
   business, this file only spawns it and forwards what it says. */

export const BLOCKS_FILE = "blocks.ndjson";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

export type Send = (ev: StreamEvent) => void;

/* Build an SSE Response stream around an async producer. Emits `done` and
   closes when the producer resolves; producer errors become `error` events. */
export function sseStream(
  run: (send: Send) => Promise<void>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: Send = (ev) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      try {
        await run(send);
      } catch (e) {
        send({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
      send({ kind: "done" });
      try {
        controller.close();
      } catch {}
    },
  });
}

/* Tail blocks.ndjson, emitting each valid line once as patch/answer. */
export function watchBlocks(
  cwd: string,
  send: Send,
  opts: { fromEnd?: boolean; file?: string } = {},
): { stop: () => Promise<void> } {
  const blocksPath = path.join(cwd, opts.file ?? BLOCKS_FILE);
  const seen = new Set<string>();
  let offset = -1; // resolved on first drain
  let buf = "";

  const emitLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.op === "string" && typeof obj.path === "string") {
        send({ kind: "patch", line: trimmed });
      } else if (typeof obj.answer === "string") {
        send({ kind: "answer", text: obj.answer });
      }
    } catch {
      send({ kind: "activity", text: `⚠ dropped malformed line (${trimmed.length} chars)` });
    }
  };

  let draining = false;
  const drain = async () => {
    // reentrancy guard: overlapping drains under event-loop stalls would
    // double-read the same region into the shared buffer and mangle lines
    if (draining) return;
    draining = true;
    try {
      if (offset === -1) {
        offset = opts.fromEnd ? (await stat(blocksPath)).size : 0;
      }
      const fh = await open(blocksPath, "r");
      const { size } = await fh.stat();
      if (size > offset) {
        const len = size - offset;
        const b = Buffer.alloc(len);
        await fh.read(b, 0, len, offset);
        offset = size;
        buf += b.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(emitLine);
      }
      await fh.close();
    } catch {
      /* file not created yet */
    } finally {
      draining = false;
    }
  };

  const poll = setInterval(drain, 200);
  return {
    stop: async () => {
      clearInterval(poll);
      await drain();
      if (buf.trim()) emitLine(buf);
    },
  };
}

/* Spawn one lane on the selected harness; resolves when the process exits.
   Only the lead lane reports its session id (that session is the resume target
   for commands, on the harnesses that can resume). */
export function runAgent(opts: {
  cwd: string;
  prompt: string;
  label: string;
  resumeThreadId?: string;
  model?: string;
  lead?: boolean;
  signal?: AbortSignal;
  send: Send;
}): Promise<void> {
  return new Promise((resolve) => {
    const { send } = opts;
    const adapter = laneAdapter();
    const spec = adapter.spawn({
      prompt: opts.prompt,
      // a resume id from a harness that cannot resume would land as a stray arg
      resumeSessionId: adapter.supportsResume ? opts.resumeThreadId : undefined,
      model: opts.model,
    });

    const child = spawn(spec.bin, [...spec.args], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // the harnesses that take the prompt on argv still need stdin closed, or
    // they sit waiting on a pipe nobody writes to
    child.stdin.end(spec.promptOnStdin ? opts.prompt : undefined);

    opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"));

    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const ev of adapter.parse(line)) {
        if (ev.sessionId && opts.lead) {
          send({ kind: "session", threadId: ev.sessionId, workdir: opts.cwd });
        }
        if (ev.activity) send({ kind: "activity", text: `[${opts.label}] ${ev.activity}` });
        if (ev.error) send({ kind: "error", text: `[${opts.label}] ${ev.error}` });
      }
    });

    child.on("close", (code) => {
      if (code !== 0 && !opts.signal?.aborted) {
        send({
          kind: "error",
          text: `lane ${opts.label} exited ${code}: ${stderrTail.split("\n").slice(-2).join(" ")}`,
        });
      }
      resolve();
    });
    child.on("error", (err) => {
      send({ kind: "error", text: `failed to spawn ${spec.bin}: ${err.message}` });
      resolve();
    });
  });
}
