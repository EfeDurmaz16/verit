"use client";

import { applySpecPatch, parseSpecStreamLine, type Spec } from "@json-render/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StreamEvent } from "./schema";

export type Focus = "all" | "security" | "protocol" | "risk";

export type Status = "idle" | "fetching" | "streaming" | "ready" | "error";

export interface Selection {
  kind: "file" | "insight" | "risk" | "node" | "check" | "step";
  payload: Record<string, unknown>;
}

export interface PrHeader {
  repo: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  url?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  threads: number;
}

export interface Answer {
  command: string;
  text: string;
  pending: boolean;
}

interface WorkspaceState {
  spec: Spec | null;
  pr: PrHeader | null;
  status: Status;
  live: boolean;
  selection: Selection | null;
  highlight: string[];
  activity: string[];
  answers: Answer[];
  error: string | null;
  commandBusy: boolean;
  proveBusy: boolean;
  focus: Focus;
  prUrl: string | null;
  analyze: (url: string) => void;
  stop: () => void;
  prove: () => void;
  sendCommand: (text: string) => void;
  select: (s: Selection | null) => void;
  flashFiles: (paths: string[]) => void;
  scrollTo: (sectionId: string) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

const Ctx = createContext<WorkspaceState | null>(null);

const EMPTY_SPEC: Spec = { root: "", elements: {} };

async function readSSE(res: Response, onEvent: (ev: StreamEvent) => void) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {
        /* skip malformed frame */
      }
    }
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const specRef = useRef<Spec>(structuredClone(EMPTY_SPEC));
  const [spec, setSpec] = useState<Spec | null>(null);
  const [pr, setPr] = useState<PrHeader | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [proveBusy, setProveBusy] = useState(false);
  const [focus, setFocus] = useState<Focus>("all");
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const session = useRef<{ threadId?: string; workdir?: string }>({});
  const booted = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const applyLines = useCallback((lines: string[]) => {
    for (const line of lines) {
      const patch = parseSpecStreamLine(line);
      if (!patch) continue;
      try {
        applySpecPatch(specRef.current, patch);
      } catch (e) {
        // never crash the workspace on a bad patch, but do make it visible
        console.warn("patch failed", line.slice(0, 200), e);
      }
    }
    // the model occasionally references a child twice; keys must be unique
    for (const el of Object.values(specRef.current.elements)) {
      if (el.children && new Set(el.children).size !== el.children.length) {
        el.children = [...new Set(el.children)];
      }
    }
    setSpec({ ...specRef.current });
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const flashFiles = useCallback((paths: string[]) => {
    setHighlight([]);
    requestAnimationFrame(() => setHighlight(paths));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setHighlight([]), 2200);
  }, []);

  const handleEvent = useCallback(
    (ev: StreamEvent) => {
      if (ev.kind === "session") {
        session.current = { threadId: ev.threadId, workdir: ev.workdir };
      } else if (ev.kind === "activity" && ev.text) {
        setActivity((a) => [...a.slice(-30), ev.text!]);
      } else if (ev.kind === "error" && ev.text) {
        setError(ev.text);
      } else if (ev.kind === "patch" && ev.line) {
        applyLines([ev.line]);
      } else if (ev.kind === "answer" && ev.text) {
        setAnswers((prev) => {
          const last = prev[prev.length - 1];
          if (last?.pending) {
            const text = last.text ? `${last.text} ${ev.text}` : ev.text!;
            return [...prev.slice(0, -1), { ...last, text }];
          }
          return [...prev, { command: "", text: ev.text!, pending: false }];
        });
      }
    },
    [applyLines],
  );

  const analyze = useCallback(
    async (url: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      specRef.current = structuredClone(EMPTY_SPEC);
      setSpec(null);
      setPr(null);
      setStatus("fetching");
      setError(null);
      setSelection(null);
      setActivity([]);
      setAnswers([]);
      setFocus("all");
      setPrUrl(url);
      try {
        localStorage.setItem("verit:pr", url);
      } catch {}
      session.current = {};
      try {
        const res = await fetch(`/api/pr?url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "failed to fetch PR");
        setPr({
          repo: json.repo,
          number: json.number,
          title: json.title,
          author: json.author,
          branch: json.branch,
          base: json.base,
          url: json.url,
          additions: json.additions,
          deletions: json.deletions,
          changedFiles: json.changedFiles,
          commits: json.commits.length,
          threads: json.comments.length,
        });
        setStatus("streaming");
        setActivity(["shell built from GitHub data", "starting analysis agent…"]);
        const stream = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: ctrl.signal,
        });
        if (!stream.ok || !stream.body) throw new Error("analysis stream failed");
        await readSSE(stream, handleEvent);
        setStatus("ready");
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [handleEvent],
  );

  // boot once: reattach to the last PR's server session, else stay idle
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const last = localStorage.getItem("verit:pr");
    if (last) analyze(last);
  }, [analyze]);

  const sendCommand = useCallback(
    async (text: string) => {
      const cmd = text.trim();
      if (!cmd) return;
      // hybrid focus: apply the local filter instantly; the agent refines after
      const t = cmd.toLowerCase();
      if (/secur/.test(t)) setFocus("security");
      else if (/protocol|compat/.test(t)) setFocus("protocol");
      else if (/risk/.test(t)) setFocus("risk");
      else if (/reset|overview|full/.test(t)) setFocus("all");
      if (!session.current.threadId || !session.current.workdir) {
        setError("No agent session yet. Load a pull request first.");
        return;
      }
      setCommandBusy(true);
      setAnswers((a) => [...a, { command: cmd, text: "", pending: true }]);
      try {
        const res = await fetch("/api/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: session.current.threadId,
            workdir: session.current.workdir,
            command: cmd,
          }),
        });
        if (!res.ok || !res.body) throw new Error("command stream failed");
        await readSSE(res, handleEvent);
        setAnswers((prev) => {
          const last = prev[prev.length - 1];
          if (last?.pending)
            return [
              ...prev.slice(0, -1),
              { ...last, text: last.text || "(workspace updated)", pending: false },
            ];
          return prev;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCommandBusy(false);
      }
    },
    [handleEvent],
  );

  /* Runs the target repo's test command on this machine. Only ever called from
     the labelled button in the Proof section, never on load or on analysis. */
  const prove = useCallback(async () => {
    if (!prUrl || proveBusy) return;
    setProveBusy(true);
    setActivity((a) => [...a.slice(-30), "running the proof command locally…"]);
    try {
      const res = await fetch("/api/prove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: prUrl }),
      });
      const json = (await res.json()) as {
        lines?: string[];
        outcome?: { command: string; exitCode: number; durationMs: number; timedOut: boolean };
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "prove failed to run");
      if (json.lines) applyLines(json.lines);
      const o = json.outcome;
      if (o) {
        const verdict = o.timedOut ? "timed out" : o.exitCode === 0 ? "passed" : `failed (exit ${o.exitCode})`;
        setActivity((a) => [
          ...a.slice(-30),
          `${o.command} ${verdict} in ${(o.durationMs / 1000).toFixed(1)}s`,
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProveBusy(false);
    }
  }, [prUrl, proveBusy, applyLines]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (prUrl) {
      void fetch("/api/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: prUrl }),
      }).catch(() => {});
    }
    setStatus("ready");
  }, [prUrl]);

  useEffect(() => {
    if (status === "streaming" || status === "fetching") document.title = "⟳ Verit: Compiling";
    else if (status === "ready") document.title = "✓ Verit: Ready";
    else document.title = "Verit";
  }, [status]);

  const select = useCallback((s: Selection | null) => setSelection(s), []);
  const scrollTo = useCallback((id: string) => {
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const value = useMemo<WorkspaceState>(
    () => ({
      spec,
      pr,
      status,
      live: status !== "idle",
      selection,
      highlight,
      activity,
      answers,
      error,
      commandBusy,
      proveBusy,
      focus,
      prUrl,
      analyze,
      stop,
      prove,
      sendCommand,
      select,
      flashFiles,
      scrollTo,
      paletteOpen,
      setPaletteOpen,
    }),
    [spec, pr, status, selection, highlight, activity, answers, error, commandBusy, proveBusy, focus, prUrl, analyze, stop, prove, sendCommand, select, flashFiles, scrollTo, paletteOpen],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace outside provider");
  return ctx;
}
