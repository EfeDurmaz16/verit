"use client";

import { useWorkspace } from "@/lib/store";
import { clsx } from "clsx";
import type { ComponentRegistry, ComponentRenderer } from "@json-render/react";
import { Children, type ReactNode } from "react";
import {
  Confidence,
  DiffStat,
  LangMark,
  Panel,
  RiskDot,
  SectionHeader,
  StatusIcon,
} from "./ui";

type P = Record<string, unknown>;
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d);
const riskOf = (v: unknown): 0 | 1 | 2 | 3 =>
  v === 1 || v === 2 || v === 3 ? v : 0;

function langOf(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "ts", js: "ts", jsx: "ts", mts: "ts",
    rs: "rs", py: "py", md: "md", mdx: "md",
    yml: "yml", yaml: "yml", toml: "yml", json: "json",
  };
  return map[ext] ?? "json";
}

/* ---------------- renderers ---------------- */

function Workspace({ children }: { props: P; children?: ReactNode }) {
  return <div className="flex flex-col gap-7">{children}</div>;
}

function Section({ props, children }: { props: P; children?: ReactNode }) {
  const { status } = useWorkspace();
  const id = str(props.id, "section");
  const empty = Children.count(children) === 0;
  if (empty && status !== "streaming") return null;
  return (
    <section
      id={`sec-${id}`}
      data-section={id}
      data-title={str(props.title)}
      className="rise-in scroll-mt-4"
    >
      <SectionHeader
        title={str(props.title)}
        hint={empty ? "pending…" : str(props.hint) || undefined}
      />
      {empty ? (
        <div className="rounded-lg border border-dashed border-line px-3 py-3">
          <div className="skeleton mb-2 h-2.5 w-2/5" />
          <div className="skeleton h-2.5 w-3/5" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">{children}</div>
      )}
    </section>
  );
}

function Columns({ props, children }: { props: P; children?: ReactNode }) {
  const split = str(props.split, "1:1");
  const cls =
    split === "2:1"
      ? "grid-cols-[2fr_1fr]"
      : split === "1:2"
        ? "grid-cols-[1fr_2fr]"
        : "grid-cols-2";
  return <div className={clsx("grid items-start gap-2", cls)}>{children}</div>;
}

function Text({ props }: { props: P }) {
  return (
    <p
      className={clsx(
        "max-w-[72ch] text-[13px]",
        str(props.tone) === "muted" ? "text-ink-3" : "text-ink-2",
      )}
    >
      {str(props.content)}
    </p>
  );
}

function Summary({ props }: { props: P }) {
  return (
    <div>
      <p className="mb-1.5 text-[15px] font-medium leading-snug">{str(props.headline)}</p>
      <p className="max-w-[72ch] text-[13px] text-ink-2">{str(props.body)}</p>
    </div>
  );
}

const CALLOUT: Record<string, string> = {
  info: "bg-accent-soft text-accent-text",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  ok: "bg-ok-soft text-ok",
};

function Callout({ props }: { props: P }) {
  return (
    <div
      className={clsx(
        "rounded-md px-3 py-2 text-[12.5px] font-medium",
        CALLOUT[str(props.tone, "info")] ?? CALLOUT.info,
      )}
    >
      {str(props.text)}
    </div>
  );
}

function MetricRow({ props }: { props: P }) {
  const metrics = arr<{ label: string; value: string; tone?: string }>(props.metrics);
  return (
    <div
      className="grid divide-x divide-line rounded-lg border border-line bg-surface"
      style={{ gridTemplateColumns: `repeat(${Math.max(metrics.length, 1)}, 1fr)` }}
    >
      {metrics.map((m, i) => (
        <div key={i} className="px-3 py-2">
          <div
            className={clsx(
              "tnum text-[17px] font-medium leading-tight",
              m.tone === "danger" ? "text-danger" : m.tone === "ok" ? "text-ok" : "text-ink",
            )}
          >
            {m.value}
          </div>
          <div className="text-[11px] text-ink-3">{m.label}</div>
        </div>
      ))}
    </div>
  );
}

function ReviewPath({ props }: { props: P }) {
  const { selection, select, flashFiles } = useWorkspace();
  const steps = arr<P>(props.steps);
  return (
    <Panel>
      <ol>
        {steps.map((s, i) => {
          const sel = selection?.kind === "step" && selection.payload.title === s.title;
          return (
            <li
              key={i}
              onClick={() => {
                select({ kind: "step", payload: s });
                flashFiles(arr<string>(s.files));
              }}
              className={clsx(
                "flex cursor-pointer items-start gap-3 px-3 py-2 transition-colors",
                i > 0 && "border-t border-line",
                sel ? "bg-accent-soft" : "hover:bg-surface-2",
              )}
            >
              <span className="tnum mt-px w-4 shrink-0 text-right font-mono text-[11px] text-ink-3">
                {i + 1}
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{str(s.title)}</span>
                  <RiskDot level={riskOf(s.risk)} />
                </div>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{str(s.why)}</p>
              </div>
              <span className="tnum shrink-0 text-[11px] text-ink-3">{num(s.minutes)}m</span>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

const PROOF_KIND: Record<string, string> = {
  test: "bg-ok-soft text-ok",
  command: "bg-surface-2 text-ink-2",
  url: "bg-accent-soft text-accent-text",
  image: "bg-warn-soft text-warn",
  video: "bg-warn-soft text-warn",
};

function ProofEvidence({ props }: { props: P }) {
  const refs = arr<P>(props.refs);
  if (!refs.length) return null;
  return (
    <Panel>
      <div className="divide-y divide-line">
        {refs.map((r, i) => {
          const value = str(r.value);
          // model-supplied: only ever linkify plain http(s), never other schemes
          const href = /^https?:\/\//i.test(value) ? value : null;
          return (
            <div key={i} className="flex items-start gap-2.5 px-3 py-2">
              <span
                className={clsx(
                  "mt-px shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
                  PROOF_KIND[str(r.kind)] ?? "bg-surface-2 text-ink-2",
                )}
              >
                {str(r.kind, "proof")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium leading-tight">{str(r.label)}</div>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-0.5 block truncate font-mono text-[11px] text-accent-text hover:underline"
                  >
                    {value}
                  </a>
                ) : (
                  <div className="mt-0.5 overflow-x-auto whitespace-pre font-mono text-[11px] text-ink-3">
                    {value}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function RiskColumn({ title, hint, items }: { title: string; hint: string; items: P[] }) {
  return (
    <Panel className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-medium">{title}</span>
        <span className="text-[11px] text-ink-3">{hint}</span>
        <span className="tnum ml-auto text-[11px] text-ink-3">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="mt-1 text-[12px] text-ink-3">none</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {items.map((r, i) => (
            <li key={i}>
              <span className="font-mono text-[11px] text-ink-3">{str(r.area)}</span>
              <p className="text-[12px] leading-snug text-ink-2">{str(r.note)}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RisksList({ props }: { props: P }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      <RiskColumn
        title="Reviewer found"
        hint="independent pass"
        items={arr<P>(props.reviewerFound)}
      />
      <RiskColumn
        title="Author declared"
        hint="hints only"
        items={arr<P>(props.authorDeclared)}
      />
    </div>
  );
}

function RiskCluster({ props }: { props: P }) {
  const { selection, select, flashFiles } = useWorkspace();
  const sel = selection?.kind === "risk" && selection.payload.title === props.title;
  return (
    <Panel
      selected={sel}
      onClick={() => {
        select({ kind: "risk", payload: props });
        flashFiles(arr<string>(props.files));
      }}
      className="px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <RiskDot level={riskOf(props.level)} />
        <span className="text-[13px] font-medium">{str(props.title)}</span>
        <span className="tnum ml-auto text-[11px] text-ink-3">
          {arr(props.files).length} files
        </span>
      </div>
      <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{str(props.summary)}</p>
    </Panel>
  );
}

const KIND_STYLE: Record<string, string> = {
  security: "bg-danger-soft text-danger",
  compat: "bg-warn-soft text-warn",
  correctness: "bg-ok-soft text-ok",
  perf: "bg-surface-2 text-ink-2",
  design: "bg-accent-soft text-accent-text",
};

function Insight({ props }: { props: P }) {
  const { selection, select, flashFiles } = useWorkspace();
  const sel = selection?.kind === "insight" && selection.payload.title === props.title;
  const evidence = arr<P>(props.evidence);
  return (
    <Panel
      selected={sel}
      onClick={() => {
        select({ kind: "insight", payload: props });
        flashFiles([
          ...arr<string>(props.files),
          ...evidence.map((e) => str(e.file)),
        ]);
      }}
      className="px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
            KIND_STYLE[str(props.kind)] ?? "bg-surface-2 text-ink-2",
          )}
        >
          {str(props.kind, "insight")}
        </span>
        <span className="truncate text-[13px] font-medium">{str(props.title)}</span>
        <span className="ml-auto shrink-0">
          <Confidence value={num(props.confidence, 0.5)} />
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-ink-2 line-clamp-2">{str(props.body)}</p>
      {evidence.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {evidence.map((ev, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                const line = parseInt(str(ev.lines), 10);
                select({
                  kind: "file",
                  payload: { path: str(ev.file), line: Number.isNaN(line) ? undefined : line },
                });
                flashFiles([str(ev.file)]);
              }}
              className="rounded-[4px] border border-line bg-surface-2/60 px-1.5 py-px font-mono text-[10px] text-ink-2 hover:border-accent hover:text-accent-text"
              title="Open in diff"
            >
              {str(ev.file).split("/").pop()}
              {ev.lines ? `:${str(ev.lines)}` : ""}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

const FOCUS_FILTER: Record<string, (f: P) => boolean> = {
  all: () => true,
  security: (f) => arr<string>(f.tags).includes("security"),
  protocol: (f) => arr<string>(f.tags).some((t) => t === "protocol" || t === "api"),
  risk: (f) => riskOf(f.risk) >= 2,
};

function FileGroup({ props }: { props: P }) {
  const { selection, select, highlight, flashFiles, focus } = useWorkspace();
  const files = arr<P>(props.files).filter(FOCUS_FILTER[focus] ?? FOCUS_FILTER.all);
  if (!files.length) return null;
  const adds = files.reduce((a, f) => a + num(f.additions), 0);
  const dels = files.reduce((a, f) => a + num(f.deletions), 0);
  return (
    <Panel>
      <div className="flex items-center gap-2 rounded-t-lg border-b border-line bg-surface-2/60 px-3 py-1.5">
        <span className="text-[12px] font-medium">{str(props.title)}</span>
        <span className="tnum text-[11px] text-ink-3">{files.length}</span>
        <span className="ml-auto">
          <DiffStat add={adds} del={dels} />
        </span>
      </div>
      <div className="divide-y divide-line">
        {files.map((f, i) => {
          const path = str(f.path);
          const sel = selection?.kind === "file" && selection.payload.path === path;
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && select({ kind: "file", payload: f })}
              onClick={() => {
                select({ kind: "file", payload: f });
                flashFiles([path]);
              }}
              className={clsx(
                "flex cursor-pointer items-center gap-2.5 px-3 py-[7px] transition-colors",
                sel ? "bg-accent-soft" : "hover:bg-surface-2",
                highlight.includes(path) && "flash-evidence",
              )}
            >
              <LangMark lang={langOf(path)} />
              <span className="truncate font-mono text-[12px]">{path}</span>
              {arr<string>(f.tags)
                .slice(0, 2)
                .map((t) => (
                  <span
                    key={t}
                    className="shrink-0 rounded-[4px] bg-surface-2 px-1 text-[10px] text-ink-2"
                  >
                    {t}
                  </span>
                ))}
              <span className="ml-auto flex shrink-0 items-center gap-3">
                <RiskDot level={riskOf(f.risk)} />
                <DiffStat add={num(f.additions)} del={num(f.deletions)} />
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function CIStatus({ props }: { props: P }) {
  const { selection, select } = useWorkspace();
  const checks = arr<P>(props.checks);
  return (
    <Panel>
      <div className="divide-y divide-line">
        {checks.map((c, i) => {
          const sel = selection?.kind === "check" && selection.payload.name === c.name;
          const status = str(c.status, "skipped") as "pass" | "fail" | "running" | "skipped";
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && select({ kind: "check", payload: c })}
              onClick={() => select({ kind: "check", payload: c })}
              className={clsx(
                "cursor-pointer px-3 py-2 transition-colors",
                sel ? "bg-accent-soft" : "hover:bg-surface-2",
              )}
            >
              <div className="flex items-center gap-2.5">
                <StatusIcon status={status} />
                <span className="truncate font-mono text-[12px]">{str(c.name)}</span>
              </div>
              {status === "fail" && c.note ? (
                <p className="mt-1 pl-6 text-[12px] leading-snug text-danger">{str(c.note)}</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function LogTail({ props }: { props: P }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
      {arr<string>(props.lines).join("\n")}
    </pre>
  );
}

function CodePreview({ props }: { props: P }) {
  const lines = arr<P>(props.lines);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-3 py-1.5">
        <span className="truncate font-mono text-[11px]">{str(props.file)}</span>
        {props.header ? (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">
            {str(props.header)}
          </span>
        ) : null}
      </div>
      <div className="overflow-x-auto font-mono text-[11px] leading-[1.6]">
        {lines.map((l, i) => {
          const kind = str(l.kind, "ctx");
          return (
            <div
              key={i}
              className={clsx(
                "flex whitespace-pre px-2",
                kind === "add" && "bg-ok-soft/60",
                kind === "del" && "bg-danger-soft/60",
              )}
            >
              <span className="tnum w-8 shrink-0 select-none pr-2 text-right text-ink-3">
                {l.no == null ? "" : String(l.no)}
              </span>
              <span
                className={clsx(
                  "w-3 shrink-0 select-none",
                  kind === "add" ? "text-ok" : kind === "del" ? "text-danger" : "text-ink-3",
                )}
              >
                {kind === "add" ? "+" : kind === "del" ? "−" : " "}
              </span>
              <span>{str(l.text)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Discussion({ props }: { props: P }) {
  const themes = arr<P>(props.themes);
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {themes.map((t, i) => (
        <Panel key={i} className="px-3 py-2">
          <span className="text-[13px] font-medium">{str(t.title)}</span>
          <span
            className={clsx(
              "mt-1 block w-fit rounded-[4px] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
              /fix|contest/i.test(str(t.stance))
                ? "bg-danger-soft text-danger"
                : /resolved/i.test(str(t.stance))
                  ? "bg-ok-soft text-ok"
                  : "bg-surface-2 text-ink-2",
            )}
          >
            {str(t.stance)}
          </span>
          <p className="mt-1 text-[12px] leading-snug text-ink-3">{str(t.body)}</p>
        </Panel>
      ))}
    </div>
  );
}

const CELL_STYLE: Record<string, string> = {
  done: "bg-ok-soft text-ok",
  partial: "bg-warn-soft text-warn",
  missing: "bg-danger-soft text-danger",
  na: "bg-surface-2 text-ink-3",
};
const CELL_LABEL: Record<string, string> = { done: "✓", partial: "◐", missing: "✗", na: "—" };

function CompatMatrix({ props }: { props: P }) {
  const columns = arr<string>(props.columns);
  const rows = arr<P>(props.rows);
  return (
    <Panel className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">
              Capability
            </th>
            {columns.map((s) => (
              <th
                key={s}
                className="px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-3"
              >
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-line last:border-0">
              <td className="px-3 py-1.5 font-medium">{str(row.capability)}</td>
              {arr<P>(row.cells).map((c, i) => (
                <td key={i} className="px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={clsx(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-medium",
                        CELL_STYLE[str(c.status, "na")],
                      )}
                    >
                      {CELL_LABEL[str(c.status, "na")]}
                    </span>
                    {c.note ? (
                      <span className="text-[11px] leading-tight text-ink-3">{str(c.note)}</span>
                    ) : null}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ArchGraph({ props }: { props: P }) {
  const { selection, select, flashFiles } = useWorkspace();
  const nodes = arr<P>(props.nodes);
  const edges = arr<P>(props.edges);
  if (!nodes.length) return null;
  const selectedId = selection?.kind === "node" ? str(selection.payload.id) : null;

  const layers = [...new Set(nodes.map((n) => num(n.layer)))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, li) => {
    const row = nodes.filter((n) => num(n.layer) === layer);
    row.forEach((n, i) => {
      pos.set(str(n.id), {
        x: ((i + 1) / (row.length + 1)) * 100,
        y: layers.length === 1 ? 50 : 10 + (li / (layers.length - 1)) * 80,
      });
    });
  });

  return (
    <div className="relative h-[300px] rounded-lg border border-line bg-surface">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {edges.map((e, i) => {
          const a = pos.get(str(e.from));
          const b = pos.get(str(e.to));
          if (!a || !b) return null;
          const active =
            selectedId !== null && (str(e.from) === selectedId || str(e.to) === selectedId);
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={active ? "var(--accent)" : e.changed ? "var(--border-strong)" : "var(--border)"}
              strokeWidth={active ? 1.5 : 1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray={e.changed ? undefined : "3 3"}
            />
          );
        })}
      </svg>
      {nodes.map((n, i) => {
        const p = pos.get(str(n.id));
        if (!p) return null;
        const sel = selectedId === str(n.id);
        return (
          <button
            key={i}
            onClick={() => {
              select({ kind: "node", payload: n });
              flashFiles(arr<string>(n.files));
            }}
            className={clsx(
              "absolute max-w-[170px] -translate-x-1/2 -translate-y-1/2 rounded-md border bg-surface px-2 py-1 text-left transition-colors",
              sel
                ? "border-accent ring-1 ring-accent/30"
                : n.changed
                  ? "border-line-strong hover:border-accent"
                  : "border-line text-ink-3 hover:border-line-strong",
            )}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
          >
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              {n.changed ? <span className="size-[6px] shrink-0 rounded-full bg-accent" /> : null}
              <span className="truncate text-[12px] font-medium leading-tight">{str(n.label)}</span>
            </span>
            <span className="block text-[10px] uppercase leading-tight tracking-wide text-ink-3">
              {str(n.kind)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TL_MARK: Record<string, string> = {
  commit: "bg-accent",
  review: "bg-ink-3",
  ci: "bg-warn",
  system: "bg-line-strong",
};

function Timeline({ props }: { props: P }) {
  const events = arr<P>(props.events);
  return (
    <Panel className="scroller max-h-[280px] overflow-y-auto px-3 py-2">
      <ol className="relative ml-1 border-l border-line pl-4">
        {events.map((e, i) => (
          <li key={i} className="relative pb-2.5 last:pb-0">
            <span
              className={clsx(
                "absolute -left-[21.5px] top-[5px] size-[7px] rounded-full",
                TL_MARK[str(e.kind, "system")],
              )}
            />
            <span className="tnum font-mono text-[11px] text-ink-3">{str(e.time)}</span>{" "}
            <span className="text-[12px] font-medium">{str(e.actor)}</span>{" "}
            <span className="text-[12px] text-ink-2">{str(e.text)}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function NextSteps({ props }: { props: P }) {
  const items = arr<P>(props.items);
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(items.length, 3) || 1}, 1fr)` }}>
      {items.map((n, i) => (
        <Panel key={i} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "size-[7px] shrink-0 rounded-full",
                str(n.kind) === "blocking"
                  ? "bg-danger"
                  : str(n.kind) === "strong"
                    ? "bg-warn"
                    : "bg-ok",
              )}
            />
            <span className="text-[13px] font-medium leading-tight">{str(n.title)}</span>
          </div>
          <p className="mt-1 text-[12px] leading-snug text-ink-3">{str(n.detail)}</p>
        </Panel>
      ))}
    </div>
  );
}

function Status({ props }: { props: P }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[12px] text-ink-3">
      <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
      {str(props.text)}
    </div>
  );
}

/* Renderer's registry is element-based: each renderer receives { element, children }.
   Props are validated defensively inside each component — the AI is untrusted input. */
const wrap =
  (C: (p: { props: P; children?: ReactNode }) => ReactNode): ComponentRenderer =>
  ({ element, children }) => <C props={(element.props ?? {}) as P}>{children}</C>;

export const registry: ComponentRegistry = {
  Workspace: wrap(Workspace),
  Section: wrap(Section),
  Columns: wrap(Columns),
  Text: wrap(Text),
  Summary: wrap(Summary),
  Callout: wrap(Callout),
  MetricRow: wrap(MetricRow),
  ReviewPath: wrap(ReviewPath),
  ProofEvidence: wrap(ProofEvidence),
  RisksList: wrap(RisksList),
  RiskCluster: wrap(RiskCluster),
  Insight: wrap(Insight),
  FileGroup: wrap(FileGroup),
  CIStatus: wrap(CIStatus),
  LogTail: wrap(LogTail),
  CodePreview: wrap(CodePreview),
  Discussion: wrap(Discussion),
  CompatMatrix: wrap(CompatMatrix),
  ArchGraph: wrap(ArchGraph),
  Timeline: wrap(Timeline),
  NextSteps: wrap(NextSteps),
  Status: wrap(Status),
};
