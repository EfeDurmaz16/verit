import { clsx } from "clsx";

const VERDICT: Record<string, { label: string; className: string }> = {
  success: { label: "proof passed", className: "bg-ok-soft text-ok" },
  failure: { label: "proof failed", className: "bg-danger-soft text-danger" },
  neutral: { label: "no proof run", className: "bg-surface-2 text-ink-2" },
};

export function Verdict({ verdict }: { verdict: string }) {
  const v = VERDICT[verdict] ?? VERDICT.neutral!;
  return (
    <span
      className={clsx(
        "shrink-0 rounded-[4px] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
        v.className,
      )}
    >
      {v.label}
    </span>
  );
}

export function Duration({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="text-ink-3">-</span>;
  return <span className="tnum">{(ms / 1000).toFixed(1)}s</span>;
}

/** One fixed format everywhere, so two rows are always comparable. */
export function When({ at }: { at: Date }) {
  return (
    <time dateTime={at.toISOString()} className="tnum text-ink-3">
      {at.toISOString().slice(0, 16).replace("T", " ")}
    </time>
  );
}

export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <p className="text-[13px] font-medium text-ink-2">{title}</p>
      <p className="mt-1 text-[12px] text-ink-3">{hint}</p>
    </div>
  );
}
