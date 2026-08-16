"use client";

import { useWorkspace } from "@/lib/store";
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { Confidence, Kbd, RiskDot, StatusIcon } from "@verit/proof-ui";

interface Hunk {
  header: string;
  lines: { kind: "ctx" | "add" | "del"; no: number | null; text: string }[];
}

/* The real diff for a selected file, fetched from the server's cached patch.
   No AI involved. Evidence chips deep-link here via payload.line. */
function DiffView({ path, line }: { path: string; line?: number }) {
  const { prUrl } = useWorkspace();
  const [hunks, setHunks] = useState<Hunk[] | null>(null);
  const [failed, setFailed] = useState(false);
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prUrl) return;
    let alive = true;
    setHunks(null);
    setFailed(false);
    fetch(`/api/diff?url=${encodeURIComponent(prUrl)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j) => alive && (j.hunks ? setHunks(j.hunks) : setFailed(true)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [prUrl, path]);

  useEffect(() => {
    if (hunks && line) target.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hunks, line]);

  if (!prUrl) return null;
  if (failed) return <p className="text-[11px] text-ink-3">Diff unavailable.</p>;
  if (!hunks)
    return (
      <div className="rounded-md border border-line p-2">
        <div className="skeleton mb-1.5 h-2.5 w-1/2" />
        <div className="skeleton h-2.5 w-3/4" />
      </div>
    );
  if (!hunks.length) return <p className="text-[11px] text-ink-3">No hunks for this file.</p>;

  return (
    <div className="flex flex-col gap-2">
      {hunks.map((h, hi) => (
        <div key={hi} className="overflow-hidden rounded-md border border-line">
          <div className="border-b border-line bg-surface-2/60 px-2 py-1 font-mono text-[10px] text-ink-3">
            {h.header}
          </div>
          <div className="scroller overflow-x-auto font-mono text-[11px] leading-[1.6]">
            {h.lines.map((l, i) => {
              const hit = line !== undefined && l.no === line;
              return (
                <div
                  key={i}
                  ref={hit ? target : undefined}
                  className={clsx(
                    "flex whitespace-pre px-1",
                    l.kind === "add" && "bg-ok-soft/60",
                    l.kind === "del" && "bg-danger-soft/60",
                    hit && "outline outline-1 outline-accent bg-accent-soft",
                  )}
                >
                  <span className="tnum w-8 shrink-0 select-none pr-1.5 text-right text-ink-3">
                    {l.no ?? ""}
                  </span>
                  <span
                    className={clsx(
                      "w-3 shrink-0 select-none",
                      l.kind === "add" ? "text-ok" : l.kind === "del" ? "text-danger" : "text-ink-3",
                    )}
                  >
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </span>
                  <span>{l.text}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

type P = Record<string, unknown>;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const riskOf = (v: unknown): 0 | 1 | 2 | 3 => (v === 1 || v === 2 || v === 3 ? v : 0);

function PanelTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="border-b border-line px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{kicker}</div>
      <div className="mt-0.5 break-words font-mono text-[12px] font-medium leading-snug">{title}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line px-3 py-2 last:border-0">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</div>
      {children}
    </div>
  );
}

function FileList({ paths }: { paths: string[] }) {
  const { spec, select, flashFiles } = useWorkspace();
  if (!paths.length) return <span className="text-[12px] text-ink-3">none</span>;
  // enrich from whatever FileGroup already knows about this path
  const lookup = (path: string): P => {
    for (const el of Object.values(spec?.elements ?? {})) {
      if (el.type !== "FileGroup") continue;
      const hit = arr<P>((el.props as P)?.files).find((f) => f.path === path);
      if (hit) return hit;
    }
    return { path };
  };
  return (
    <>
      {paths.map((p) => (
        <button
          key={p}
          onClick={() => {
            select({ kind: "file", payload: lookup(p) });
            flashFiles([p]);
          }}
          className="block w-full truncate rounded-[4px] px-1 py-0.5 text-left font-mono text-[11px] text-accent-text hover:bg-accent-soft"
          title={`${p}: open diff`}
        >
          {p}
        </button>
      ))}
    </>
  );
}

export function ContextPanel() {
  const { selection, status, activity, live, pr } = useWorkspace();
  const p: P = selection?.payload ?? {};

  let content: React.ReactNode = null;

  if (selection?.kind === "file") {
    content = (
      <>
        <PanelTitle kicker="File" title={str(p.path)} />
        <Field label="Change">
          <div className="flex items-center gap-3">
            <span className="tnum font-mono text-[11px]">
              <span className="text-ok">+{num(p.additions)}</span>{" "}
              <span className="text-danger">−{num(p.deletions)}</span>
            </span>
            <RiskDot level={riskOf(p.risk)} label />
            {arr<string>(p.tags).map((t) => (
              <span key={t} className="rounded-[4px] bg-surface-2 px-1.5 py-px text-[10px] text-ink-2">
                {t}
              </span>
            ))}
          </div>
        </Field>
        {p.note ? (
          <Field label="What changed">
            <p className="text-[12px] leading-snug text-ink-2">{str(p.note)}</p>
          </Field>
        ) : null}
        {live && (
          <Field label={p.line ? `Diff · line ${num(p.line)}` : "Diff"}>
            <DiffView path={str(p.path)} line={p.line ? num(p.line) : undefined} />
          </Field>
        )}
        {live && pr?.url && (
          <Field label="Source">
            <a
              className="text-[12px] text-accent-text hover:underline"
              href={`${pr.url}/files`}
              target="_blank"
              rel="noreferrer"
            >
              Open diff on GitHub ↗
            </a>
          </Field>
        )}
      </>
    );
  } else if (selection?.kind === "insight") {
    const evidence = arr<P>(p.evidence);
    content = (
      <>
        <PanelTitle kicker={`Insight · ${str(p.kind, "finding")}`} title={str(p.title)} />
        <Field label="Confidence">
          <Confidence value={num(p.confidence, 0.5)} />
        </Field>
        <Field label="Finding">
          <p className="text-[12px] leading-snug text-ink-2">{str(p.body)}</p>
        </Field>
        {p.reasoning ? (
          <Field label="Reasoning">
            <p className="text-[12px] leading-snug text-ink-3">{str(p.reasoning)}</p>
          </Field>
        ) : null}
        <Field label={`Evidence (${evidence.length})`}>
          <div className="flex flex-col gap-2">
            {evidence.map((ev, i) => (
              <div key={i} className="rounded-md border border-line">
                <div className="flex items-center gap-1 border-b border-line bg-surface-2/60 px-2 py-1">
                  <span className="truncate font-mono text-[11px]">{str(ev.file)}</span>
                  {ev.lines ? (
                    <span className="tnum shrink-0 font-mono text-[10px] text-ink-3">
                      {str(ev.lines)}
                    </span>
                  ) : null}
                </div>
                {ev.excerpt ? (
                  <pre className="overflow-x-auto whitespace-pre-wrap px-2 py-1.5 font-mono text-[11px] leading-snug text-ink-2">
                    {str(ev.excerpt)}
                  </pre>
                ) : null}
                {ev.note ? (
                  <p className="border-t border-line px-2 py-1 text-[11px] text-ink-3">{str(ev.note)}</p>
                ) : null}
              </div>
            ))}
          </div>
        </Field>
        <Field label="Affected files">
          <FileList paths={arr<string>(p.files)} />
        </Field>
      </>
    );
  } else if (selection?.kind === "risk") {
    content = (
      <>
        <PanelTitle kicker="Risk cluster" title={str(p.title)} />
        <Field label="Level">
          <RiskDot level={riskOf(p.level)} label />
        </Field>
        <Field label="Why it's risky">
          <p className="text-[12px] leading-snug text-ink-2">{str(p.summary)}</p>
        </Field>
        <Field label={`Affected files (${arr(p.files).length})`}>
          <FileList paths={arr<string>(p.files)} />
        </Field>
      </>
    );
  } else if (selection?.kind === "node") {
    content = (
      <>
        <PanelTitle kicker={`Subsystem · ${str(p.kind)}`} title={str(p.label)} />
        {p.detail ? (
          <Field label="Role">
            <p className="text-[12px] leading-snug text-ink-2">{str(p.detail)}</p>
          </Field>
        ) : null}
        <Field label={p.changed ? "Changed in this PR" : "Unchanged dependency"}>
          <FileList paths={arr<string>(p.files)} />
        </Field>
      </>
    );
  } else if (selection?.kind === "check") {
    content = (
      <>
        <PanelTitle kicker="CI check" title={str(p.name)} />
        <Field label="Status">
          <div className="flex items-center gap-2">
            <StatusIcon status={str(p.status, "skipped") as "pass" | "fail" | "running" | "skipped"} />
            <span className="text-[12px] capitalize">{str(p.status)}</span>
          </div>
        </Field>
        {p.note ? (
          <Field label="Failure">
            <p className="text-[12px] leading-snug text-danger">{str(p.note)}</p>
          </Field>
        ) : null}
        {p.url ? (
          <Field label="Source">
            <a className="text-[12px] text-accent-text hover:underline" href={str(p.url)} target="_blank" rel="noreferrer">
              Open run on GitHub ↗
            </a>
          </Field>
        ) : null}
      </>
    );
  } else if (selection?.kind === "step") {
    content = (
      <>
        <PanelTitle kicker="Review step" title={str(p.title)} />
        <Field label="Why this order">
          <p className="text-[12px] leading-snug text-ink-2">{str(p.why)}</p>
        </Field>
        <Field label="Budget">
          <span className="tnum text-[12px]">{num(p.minutes)} minutes</span>
          <span className="ml-3 inline-flex">
            <RiskDot level={riskOf(p.risk)} label />
          </span>
        </Field>
        <Field label={`Files (${arr(p.files).length})`}>
          <FileList paths={arr<string>(p.files)} />
        </Field>
      </>
    );
  }

  if (!content) {
    content = (
      <div className="flex h-full flex-col">
        <div className="px-3 py-6 text-center">
          <p className="text-[12px] text-ink-3">
            Select a file, insight, risk, or subsystem
            <br />
            to inspect its evidence here.
          </p>
          <p className="mt-3 text-[11px] text-ink-3">
            <Kbd>⌘K</Kbd> commands · <Kbd>/</Kbd> ask
          </p>
        </div>
        {(status === "streaming" || (activity.length > 0 && live)) && (
          <div className="mt-auto border-t border-line">
            <div className="flex items-center gap-2 px-3 pb-1 pt-2">
              {status === "streaming" && (
                <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
              )}
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
                Agent activity
              </span>
            </div>
            <div className="scroller max-h-[40vh] overflow-y-auto px-3 pb-2">
              {activity.slice(-14).map((a, i) => (
                <div key={i} className="truncate py-[3px] font-mono text-[10.5px] text-ink-3" title={a}>
                  {a}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return <div className="scroller h-full overflow-y-auto">{content}</div>;
}
