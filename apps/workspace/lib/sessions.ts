import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { laneEnabled, makeLaneHarness } from "@verit/lane";
import { StoreError } from "@verit/ports";
import type { Understanding } from "@verit/domain";
import { runAgent, watchBlocks, type Send } from "./lane";
import { prefetchPR } from "./prefetch";
import { PROMPT_VERSION, understandPrompt } from "./prompt";
import { proveActionPatches, proveOffer } from "./prove";
import { persistReviewRun, readStoredUnderstanding, reviewViaLane } from "./review-run";
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

const g = globalThis as unknown as { __veritLive?: Map<string, LiveSession> };
const liveSessions = (g.__veritLive ??= new Map<string, LiveSession>());

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

const MODEL = process.env.VERIT_LANE_MODEL;

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

const removeStatusSection = patch(
  JSON.stringify({ op: "remove", path: "/elements/ws/children/0" }),
);

interface LaneOutcome {
  /** The validated Understanding, or null when the lane did not complete. */
  understanding: Understanding | null;
  /** Set when the pipeline already persisted the run (provider path). */
  runId: string | null;
  /** A human sentence when the lane could not produce an Understanding. */
  error: string | null;
}

function laneFailureText(e: unknown): string {
  const inner =
    e instanceof StoreError && e.cause instanceof Error
      ? e.cause.message
      : e instanceof Error
        ? e.message
        : String(e);
  return `The analysis lane could not run: ${inner}. Check VERIT_LANE_PROVIDER, VERIT_LANE_MODEL and the API key, then load the pull request again.`;
}

/**
 * Legacy path: spawn the codex/claude/cursor CLI, tail the blocks it drafts,
 * and read the Understanding it wrote to disk. Reached only when no
 * VERIT_LANE_PROVIDER is set.
 */
async function runCliLane(
  pr: PRMeta,
  workdir: string,
  signal: AbortSignal,
  send: Send,
): Promise<LaneOutcome> {
  send({ kind: "activity", text: "starting the understand lane (coding CLI)…" });
  const watcher = watchBlocks(workdir, send);
  await runAgent({
    cwd: workdir,
    prompt: understandPrompt(pr),
    label: "understand",
    lead: true,
    model: MODEL,
    signal,
    send,
  });
  await watcher.stop();
  send(removeStatusSection);
  if (signal.aborted) return { understanding: null, runId: null, error: null };
  const result = await readUnderstanding(workdir);
  if (!result.ok) return { understanding: null, runId: null, error: result.error };
  return { understanding: result.understanding, runId: null, error: null };
}

/**
 * Default path: the harness-independent HTTP lane (@verit/lane). No coding CLI,
 * no blocks.ndjson. The lane returns the Understanding directly and the
 * pipeline persists it, so the run id is already in hand.
 */
async function runProviderLane(
  pr: PRMeta,
  signal: AbortSignal,
  send: Send,
): Promise<LaneOutcome> {
  send(
    patch(
      JSON.stringify({
        op: "replace",
        path: "/elements/status-el/props/text",
        value: "Running the understand lane. The review renders when it returns.",
      }),
    ),
  );
  send({ kind: "activity", text: "running the harness-independent understand lane…" });
  try {
    // ponytail: stop detaches the client at once, but the server lane runs to
    // its VERIT_LANE_TIMEOUT_MS cap before releasing. Thread the signal into
    // laneClientFor's fetch to cut a running request sooner.
    const { runId, understanding } = await reviewViaLane(pr, makeLaneHarness(), signal);
    return { understanding, runId, error: null };
  } catch (e) {
    if (signal.aborted) return { understanding: null, runId: null, error: null };
    return { understanding: null, runId: null, error: laneFailureText(e) };
  } finally {
    // drop the status section whatever happened, so it never spins forever
    send(removeStatusSection);
  }
}

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

      // Harness-independent HTTP lane is the default whenever a provider is
      // named (VERIT_LANE_PROVIDER), exactly as the CLI and the Action select
      // it. The codex/claude/cursor CLI is the legacy fallback, reached only
      // when no provider is set.
      const outcome = laneEnabled()
        ? await runProviderLane(pr, s.abort.signal, send)
        : await runCliLane(pr, workdir, s.abort.signal, send);

      if (s.abort.signal.aborted) {
        send({ kind: "activity", text: "analysis stopped by user" });
        failure = "stopped by user";
      } else if (outcome.error) {
        failure = outcome.error;
        send({ kind: "error", text: outcome.error });
        send(patch(unverifiedCallout(outcome.error)));
      } else if (!outcome.understanding) {
        failure = "analysis did not complete";
        send(
          patch(
            unverifiedCallout(
              "The lane finished without a usable Understanding. This run is neutral, not a pass. Load the pull request again to retry.",
            ),
          ),
        );
      } else {
        // schema-valid: canonical render replaces whatever the lane drafted
        for (const line of understandingPatches(outcome.understanding)) send(patch(line));
        reviewRunId = outcome.runId ?? (await persistReviewRun(pr, outcome.understanding));
        send({ kind: "activity", text: `understanding stored as ${reviewRunId}` });
        // the prove control appears only once there is a run to attach
        // evidence to, and it never fires itself
        for (const line of proveActionPatches(await proveOffer(pr.repo))) send(patch(line));
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
