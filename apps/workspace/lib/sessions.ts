import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { runAgent, watchBlocks, type Send } from "./lane";
import { prefetchPR } from "./prefetch";
import { PROMPT_VERSION, understandPrompt } from "./prompt";
import { proveActionPatches, proveOffer } from "./prove";
import { persistReviewRun, readStoredUnderstanding } from "./review-run";
import type { PRMeta, StreamEvent } from "./schema";
import { buildShellSpec } from "./shell-spec";
import { sessionStore, WORKSPACE_ROOT } from "./stores";
import { readUnderstanding, understandingPatches } from "./understanding";

/* Detached analysis sessions. Lanes run server-side, independent of any client
   connection: clients (re)attach and get a replay + live tail, so a page
   refresh loses nothing and kills nothing.

   Durable state lives in the SessionStore (session + run rows) and on disk
   under WORKSPACE_ROOT (prefetched PR data, the SpecStream log, the
   Understanding JSON). Only the live listener set is process-local. That is
   connection state, not session state, so a finished run still replays after
   a restart. */

const EVENTS_FILE = "events.ndjson";

export interface LiveSession {
  id: string;
  pr: PRMeta;
  workdir: string;
  runId: string;
  events: StreamEvent[];
  status: "running" | "done";
  threadId: string | null;
  listeners: Set<Send>;
  abort: AbortController;
  writes: Promise<void>;
}

const g = globalThis as unknown as { __cyclopsLive?: Map<string, LiveSession> };
const liveSessions = (g.__cyclopsLive ??= new Map<string, LiveSession>());

/** Stable per PR head and prompt version, and safe as a directory name. */
export function sessionId(pr: PRMeta): string {
  const head = (pr.headSha || "nohead").slice(0, 12);
  return `${pr.repo.replaceAll("/", "_")}-${pr.number}-${head}-${PROMPT_VERSION}`;
}

export const workdirOf = (id: string): string => path.join(WORKSPACE_ROOT, id);

/** True only for a workdir this app created. Never an arbitrary path. */
export function isWorkspaceDir(dir: string): boolean {
  const resolved = path.resolve(dir);
  return (
    resolved.startsWith(WORKSPACE_ROOT + path.sep) &&
    path.dirname(resolved) === WORKSPACE_ROOT
  );
}

export function getLiveSession(pr: PRMeta): LiveSession | undefined {
  return liveSessions.get(sessionId(pr));
}

export function stopSession(pr: PRMeta): boolean {
  const s = liveSessions.get(sessionId(pr));
  if (!s || s.status !== "running") return false;
  s.abort.abort();
  return true;
}

const MODEL = process.env.CYCLOPS_LANE_MODEL;

function broadcast(s: LiveSession, ev: StreamEvent) {
  if (ev.kind === "session" && ev.threadId) s.threadId = ev.threadId;
  s.events.push(ev);
  // serialize appends so concurrent events cannot interleave inside a line
  s.writes = s.writes
    .then(() => appendFile(path.join(s.workdir, EVENTS_FILE), `${JSON.stringify(ev)}\n`))
    .catch(() => {});
  for (const l of s.listeners) l(ev);
}

const patch = (line: string): StreamEvent => ({ kind: "patch", line });

export async function startSession(pr: PRMeta): Promise<LiveSession> {
  const id = sessionId(pr);
  const existing = liveSessions.get(id);
  if (existing) return existing;

  const workdir = workdirOf(id);
  await mkdir(workdir, { recursive: true });
  const startedAt = new Date().toISOString();
  const runId = `wr:${id}:${Date.now()}`;

  const s: LiveSession = {
    id,
    pr,
    workdir,
    runId,
    events: [],
    status: "running",
    threadId: null,
    listeners: new Set(),
    abort: new AbortController(),
    writes: Promise.resolve(),
  };
  liveSessions.set(id, s);

  await Effect.runPromise(
    sessionStore().upsertSession({
      id,
      repo: pr.repo,
      prNumber: pr.number,
      headSha: pr.headSha,
      workdir,
      createdAt: startedAt,
    }),
  );
  await Effect.runPromise(
    sessionStore().upsertRun({
      id: runId,
      sessionId: id,
      status: "running",
      threadId: null,
      reviewRunId: null,
      error: null,
      startedAt,
      finishedAt: null,
    }),
  );

  for (const line of buildShellSpec(pr).lines) broadcast(s, patch(line));

  // detached runner, outlives any request
  void (async () => {
    const send: Send = (ev) => broadcast(s, ev);
    let reviewRunId: string | null = null;
    let failure: string | null = null;
    try {
      send({ kind: "activity", text: "prefetching diff, comments, CI logs…" });
      await prefetchPR(pr, workdir);
      send({ kind: "activity", text: "starting the understand lane…" });
      const watcher = watchBlocks(workdir, send);
      await runAgent({
        cwd: workdir,
        prompt: understandPrompt(pr),
        label: "understand",
        lead: true,
        model: MODEL,
        signal: s.abort.signal,
        send,
      });
      await watcher.stop();
      // drop the status section now that the lane is finished
      send(patch(JSON.stringify({ op: "remove", path: "/elements/ws/children/0" })));

      if (s.abort.signal.aborted) {
        send({ kind: "activity", text: "analysis stopped by user" });
        failure = "stopped by user";
      } else {
        const result = await readUnderstanding(workdir);
        if (!result.ok) {
          failure = result.error;
          send({ kind: "error", text: result.error });
          send(patch(unverifiedCallout(result.error)));
        } else {
          // schema-valid: canonical render replaces whatever the lane drafted
          for (const line of understandingPatches(result.understanding)) send(patch(line));
          reviewRunId = await persistReviewRun(pr, result.understanding);
          send({ kind: "activity", text: `understanding stored as ${reviewRunId}` });
          // the prove control appears only once there is a run to attach
          // evidence to, and it never fires itself
          for (const line of proveActionPatches(await proveOffer(pr.repo))) send(patch(line));
        }
      }
      if (s.threadId) send({ kind: "session", threadId: s.threadId, workdir });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      broadcast(s, { kind: "error", text: failure });
    } finally {
      await Effect.runPromise(
        sessionStore().upsertRun({
          id: runId,
          sessionId: id,
          status: failure ? "error" : "done",
          threadId: s.threadId,
          reviewRunId,
          error: failure,
          startedAt,
          finishedAt: new Date().toISOString(),
        }),
      ).catch(() => {});
      await s.writes;
      s.status = "done";
      for (const l of s.listeners) l({ kind: "done" });
      s.listeners.clear();
    }
  })();

  return s;
}

const unverifiedCallout = (reason: string): string =>
  JSON.stringify({
    op: "add",
    path: "/elements/u-unverified",
    value: {
      type: "Callout",
      props: { tone: "warn", text: `Unverified run: ${reason}` },
      children: [],
    },
  });

/**
 * Everything a finished run needs to be shown again, without re-running it:
 * the SpecStream log from disk plus the Understanding the store kept.
 */
export async function replayEvents(pr: PRMeta): Promise<StreamEvent[] | null> {
  const id = sessionId(pr);
  const session = await Effect.runPromise(sessionStore().getSession(id)).catch(() => null);
  if (!session) return null;
  const run = await Effect.runPromise(sessionStore().latestRun(id)).catch(() => null);
  if (!run || run.status === "running") return null;

  let log: string;
  try {
    log = await readFile(path.join(session.workdir, EVENTS_FILE), "utf8");
  } catch {
    return null;
  }
  const events: StreamEvent[] = [];
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as StreamEvent);
    } catch {
      /* a torn final line: ignore */
    }
  }
  if (run.reviewRunId) {
    const stored = await readStoredUnderstanding(run.reviewRunId);
    // re-assert the canonical sections straight from the store, including any
    // proof refs a previous prove wrote
    if (stored) events.push(...understandingPatches(stored).map(patch));
    events.push(...proveActionPatches(await proveOffer(session.repo)).map(patch));
  }
  events.push({ kind: "activity", text: `replayed run ${run.id} from the store` });
  if (run.threadId) {
    events.push({ kind: "session", threadId: run.threadId, workdir: session.workdir });
  }
  return events;
}

const enc = new TextEncoder();
const frame = (ev: StreamEvent) => enc.encode(`data: ${JSON.stringify(ev)}\n\n`);

/** SSE stream of a fixed event list (finished run, replayed from the store). */
export function replayStream(events: StreamEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(frame(ev));
      controller.enqueue(frame({ kind: "done" }));
      controller.close();
    },
  });
}

/** SSE stream for one client on a live session: replay history, then tail. */
export function attachStream(s: LiveSession): ReadableStream<Uint8Array> {
  let listener: Send | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send: Send = (ev) => {
        try {
          controller.enqueue(frame(ev));
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
      if (listener) liveSessions.get(s.id)?.listeners.delete(listener);
    },
  });
}
