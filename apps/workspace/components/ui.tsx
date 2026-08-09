"use client";

import type { Risk } from "@/lib/types";
import { clsx } from "clsx";
import type { ReactNode } from "react";

export function SectionHeader({
  title,
  count,
  hint,
  right,
}: {
  title: string;
  count?: number;
  hint?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 mb-2">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
        {title}
      </h2>
      {count !== undefined && (
        <span className="tnum text-[11px] text-ink-3">{count}</span>
      )}
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

export function Panel({
  children,
  className,
  onClick,
  selected,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={clsx(
        "rounded-lg border bg-surface",
        selected ? "border-accent ring-1 ring-accent/30" : "border-line",
        onClick &&
          "cursor-pointer transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
    >
      {children}
    </div>
  );
}

const RISK_LABEL: Record<Risk, string> = { 0: "none", 1: "low", 2: "medium", 3: "high" };
const RISK_DOT: Record<Risk, string> = {
  0: "bg-line-strong",
  1: "bg-ink-3",
  2: "bg-warn",
  3: "bg-danger",
};

export function RiskDot({ level, label }: { level: Risk; label?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <span className={clsx("size-[7px] rounded-full", RISK_DOT[level])} />
      {label && (
        <span className="text-[11px] text-ink-3">{RISK_LABEL[level]}</span>
      )}
    </span>
  );
}

export function StatusIcon({
  status,
}: {
  status: "pass" | "fail" | "running" | "skipped";
}) {
  if (status === "pass")
    return (
      <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-ok-soft text-ok shrink-0">
        <svg viewBox="0 0 10 10" className="size-2" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M1.5 5.5 4 8l4.5-6" />
        </svg>
      </span>
    );
  if (status === "fail")
    return (
      <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-danger-soft text-danger shrink-0">
        <svg viewBox="0 0 10 10" className="size-2" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 2l6 6M8 2 2 8" />
        </svg>
      </span>
    );
  if (status === "running")
    return (
      <span className="inline-flex size-3.5 items-center justify-center shrink-0">
        <span className="size-2.5 rounded-full border-[1.5px] border-line-strong border-t-accent animate-spin" />
      </span>
    );
  return <span className="size-3.5 rounded-full bg-surface-3 shrink-0" />;
}

const LANG_COLOR: Record<string, string> = {
  ts: "#2563ff",
  rs: "#b7562d",
  py: "#1d6f42",
  md: "#818181",
  yml: "#8a5a10",
  json: "#545454",
};

export function LangMark({ lang }: { lang: string }) {
  return (
    <span
      className="inline-block size-[7px] rounded-[2px] shrink-0"
      style={{ background: LANG_COLOR[lang] ?? "#818181" }}
      title={lang}
    />
  );
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="tnum font-mono text-[11px] shrink-0">
      <span className="text-ok">+{add}</span>{" "}
      <span className="text-danger">−{del}</span>
    </span>
  );
}

export function Confidence({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex gap-px">
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <span
            key={t}
            className={clsx(
              "h-[9px] w-[3px] rounded-[1px]",
              value >= t ? "bg-accent" : "bg-surface-3",
            )}
          />
        ))}
      </span>
      <span className="tnum text-[11px] text-ink-3">
        {Math.round(value * 100)}%
      </span>
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-line bg-surface-2 px-1 py-px font-mono text-[10px] text-ink-2">
      {children}
    </kbd>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} />;
}

export function SkeletonBlock({ title }: { title: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="size-2 rounded-full border-[1.5px] border-line-strong border-t-accent animate-spin" />
        <span className="text-[11px] text-ink-3">{title}</span>
      </div>
      <Skeleton className="h-3 w-3/4 mb-2" />
      <Skeleton className="h-3 w-1/2 mb-2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}
