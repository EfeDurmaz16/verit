import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent, watchBlocks, type Send } from "./codex";
import { prefetchPR, saveCache } from "./prefetch";
import { laneFile, lanePrompts } from "./prompt";
import type { PRMeta, StreamEvent } from "./schema";
import { buildShellSpec } from "./shell-spec";

/* Detached analysis sessions: lanes run server-side, independent of any
   client connection. Clients (re)attach and get a replay + live tail, so a
   page refresh loses nothing and kills nothing.
   ponytail: in-memory registry — dev-server restart or HMR of this module
   drops running sessions; a store is needed for multi-process deployments. */

interface Session {
  key: string;
  pr: PRMeta;
  workdir: string;
  events: StreamEvent[]; // everything broadcast so far (shell + lanes)
  status: "running" | "done";
  threadId: string | null;
  listeners: Set<Send>;
  abort: AbortController;
  startedAt: number;
}

const globalStore = globalThis as unknown as { __latticeSessions?: Map<string, Session> };
const sessions = (globalStore.__latticeSessions ??= new Map<string, Session>());

export function sessionKey(pr: PRMeta): string {
  return `${pr.repo}#${pr.number}@${pr.headSha}`;
}

export function getSession(pr: PRMeta): Session | undefined {
  return sessions.get(sessionKey(pr));
}

export function stopSession(pr: PRMeta): boolean {
  const s = sessions.get(sessionKey(pr));
  if (!s || s.status !== "running") return false;
  s.abort.abort();
  return true;
}

const MODEL_FOR: Record<"smart" | "fast", string | undefined> = {
  smart: process.env.LATTICE_MODEL_SMART,
  fast: process.env.LATTICE_MODEL_FAST ?? process.env.LATTICE_MODEL_SMART,
};

function broadcast(s: Session, ev: StreamEvent) {
  if (ev.kind === "session" && ev.threadId) s.threadId = ev.threadId;
  s.events.push(ev);
  for (const l of s.listeners) l(ev);
}

function finish(s: Session) {
  s.status = "done";
  for (const l of s.listeners) l({ kind: "done" });
  s.listeners.clear();
  // keep the finished session around for late reattaches until dev restart
}

export async function startSession(pr: PRMeta): Promise<Session> {
  const existing = sessions.get(sessionKey(pr));
  if (existing) return existing;

  const workdir = await mkdtemp(path.join(os.tmpdir(), "lattice-"));
  const s: Session = {
    key: sessionKey(pr),
    pr,
    workdir,
    events: [],
    status: "running",
    threadId: null,
    listeners: new Set(),
    abort: new AbortController(),
    startedAt: Date.now(),
  };
  sessions.set(s.key, s);

  const shell = buildShellSpec(pr);
  for (const line of shell.lines) broadcast(s, { kind: "patch", line });

  // detached runner — outlives any request
  void (async () => {
    const send: Send = (ev) => broadcast(s, ev);
    try {
      send({ kind: "activity", text: "prefetching diff, comments, CI logs…" });
      await prefetchPR(pr, workdir);
      send({ kind: "activity", text: "starting 3 analysis lanes…" });
      // one blocks file per lane: no cross-process append interleaving
      const lanes = lanePrompts(pr);
      const watchers = lanes.map((lane) =>
        watchBlocks(workdir, send, { file: laneFile(lane.label) }),
      );
      await Promise.all(
        lanes.map((lane) =>
          runAgent({
            cwd: workdir,
            prompt: lane.prompt,
            label: lane.label,
            lead: lane.lead,
            model: MODEL_FOR[lane.tier],
            signal: s.abort.signal,
            send,
          }),
        ),
      );
      await Promise.all(watchers.map((w) => w.stop()));
      send({
        kind: "patch",
        line: JSON.stringify({ op: "remove", path: "/elements/ws/children/0" }),
      });
      if (s.threadId)
        send({ kind: "session", threadId: s.threadId, workdir });
      if (!s.abort.signal.aborted) await saveCache(pr, workdir, s.threadId);
      if (s.abort.signal.aborted)
        send({ kind: "activity", text: "analysis stopped by user" });
    } catch (e) {
      broadcast(s, { kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      finish(s);
    }
  })();

  return s;
}

/* SSE stream for one client: replay history, then live-tail until done. */
export function attachStream(s: Session): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let listener: Send | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send: Send = (ev) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      for (const ev of s.events) send(ev);
      if (s.status !== "running") {
        send({ kind: "done" });
        try {
          controller.close();
        } catch {}
        return;
      }
      listener = (ev) => {
        send(ev);
        if (ev.kind === "done") {
          try {
            controller.close();
          } catch {}
        }
      };
      s.listeners.add(listener);
    },
    cancel() {
      if (listener) sessions.get(s.key)?.listeners.delete(listener);
    },
  });
}
