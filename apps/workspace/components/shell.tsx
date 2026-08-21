"use client";

import { useWorkspace } from "@/lib/store";
import { clsx } from "clsx";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { Kbd } from "@verit/proof-ui";

/* ---------------- header ---------------- */

export function Header() {
  const { pr, status, error, analyze, stop, focus, setPaletteOpen } = useWorkspace();
  const [url, setUrl] = useState("");

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-surface px-4">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight">
        <span className="inline-block size-[9px] rounded-[2px] bg-accent" />
        Verit
      </span>
      <span className="h-4 w-px bg-line" />
      {pr ? (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[12px] text-ink-2">
            {pr.repo}
            <span className="text-ink-3">#{pr.number}</span>
          </span>
          <span className="truncate text-[13px] font-medium">{pr.title}</span>
          <span className="hidden shrink-0 rounded-[4px] bg-surface-2 px-1.5 py-px font-mono text-[10px] text-ink-3 lg:inline">
            {pr.branch} → {pr.base}
          </span>
        </div>
      ) : (
        <span className="text-[13px] text-ink-3">
          {status === "fetching" ? "Fetching pull request…" : "No pull request loaded"}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {focus !== "all" && (
          <span className="rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
            focus: {focus}
          </span>
        )}
        <StatusChip status={status} error={error} />
        {status === "streaming" && (
          <button
            onClick={stop}
            className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-danger hover:text-danger"
          >
            Stop
          </button>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) analyze(url.trim());
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="github.com/owner/repo/pull/123"
            aria-label="GitHub pull request URL"
            className="w-[260px] rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
          />
        </form>
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-line-strong"
        >
          Commands <Kbd>⌘K</Kbd>
        </button>
      </div>
    </header>
  );
}

function StatusChip({ status, error }: { status: string; error: string | null }) {
  if (status === "error")
    return (
      <span
        className="max-w-[300px] truncate rounded-md bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger"
        title={error ?? ""}
      >
        {error ?? "error"}
      </span>
    );
  if (status === "idle") return null;
  if (status === "fetching" || status === "streaming")
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
        <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
        {status === "fetching" ? "fetching PR" : "compiling workspace"}
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
      <span className="live-dot size-[7px] rounded-full bg-ok" />
      synced
    </span>
  );
}

/* ---------------- left rail (derived from the AI-built spec) ---------------- */

export function useSections(): { id: string; title: string; empty: boolean }[] {
  const { spec } = useWorkspace();
  if (!spec?.root) return [];
  const root = spec.elements[spec.root];
  if (!root) return [];
  return (root.children ?? [])
    .map((key: string) => spec.elements[key])
    .filter((el) => el?.type === "Section")
    .map((el) => {
      const props = (el.props ?? {}) as { id?: string; title?: string };
      return {
        id: props.id ?? "section",
        title: props.title ?? "Section",
        empty: (el.children ?? []).length === 0,
      };
    });
}

export function Rail() {
  const { scrollTo, focus, status } = useWorkspace();
  const sections = useSections().filter((s) => !s.empty || status === "streaming");
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const els = document.querySelectorAll("[data-section]");
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.getAttribute("data-section")!);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((s) => obs.observe(s));
    return () => obs.disconnect();
  }, [sections.length]);

  return (
    <nav className="hidden w-[168px] shrink-0 flex-col border-r border-line bg-surface pt-2 md:flex">
      <div className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
        Task
      </div>
      {sections.map((s) => {
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            onClick={() => scrollTo(s.id)}
            disabled={s.empty}
            className={clsx(
              "relative mx-1.5 flex items-center rounded-md px-2 py-[5px] text-left text-[12.5px] transition-colors rise-in",
              s.empty
                ? "cursor-default text-ink-3/60"
                : isActive
                  ? "bg-surface-2 font-medium text-ink"
                  : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {isActive && !s.empty && (
              <span className="absolute -left-1.5 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-accent" />
            )}
            {s.title}
            {s.empty && <span className="ml-auto text-[10px]">·</span>}
          </button>
        );
      })}
      {status === "streaming" && (
        <div className="mx-1.5 flex items-center gap-2 px-2 py-[5px] text-[12px] text-ink-3">
          <span className="size-2 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
          compiling…
        </div>
      )}
      <div className="mt-auto border-t border-line px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.08em] text-ink-3">View</div>
        <div className="mt-0.5 text-[11.5px] text-ink-2">
          {focus === "all" ? "Full review" : `Focused: ${focus}`}
        </div>
      </div>
    </nav>
  );
}

/* ---------------- command palette ---------------- */

const ITEM_CLS =
  "cursor-pointer rounded-md px-2 py-1.5 text-[12.5px] text-ink-2 data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink";
const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-ink-3";

export function Palette() {
  const { paletteOpen, setPaletteOpen, sendCommand, scrollTo } = useWorkspace();
  const sections = useSections();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPaletteOpen]);

  if (!paletteOpen) return null;

  const run = (fn: () => void) => {
    setPaletteOpen(false);
    fn();
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/10" onClick={() => setPaletteOpen(false)}>
      <div
        className="mx-auto mt-[12vh] w-[540px] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_8px_32px_rgba(0,0,0,0.10)]"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Workspace commands">
          <Command.Input
            autoFocus
            placeholder="Type a command…"
            className="w-full border-b border-line bg-transparent px-4 py-3 text-[13px] outline-none placeholder:text-ink-3"
          />
          <Command.List className="scroller max-h-[320px] overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-[12px] text-ink-3">
              No matching command.
            </Command.Empty>
            <Command.Group heading="Reorganize" className={GROUP_CLS}>
              {[
                "Focus on security-relevant changes",
                "Focus on protocol compatibility",
                "Show highest-risk areas only",
                "Reset the view",
              ].map((c) => (
                <Command.Item key={c} onSelect={() => run(() => sendCommand(c))} className={ITEM_CLS}>
                  {c}
                </Command.Item>
              ))}
            </Command.Group>
            {sections.length > 0 && (
              <Command.Group heading="Jump to" className={GROUP_CLS}>
                {sections.map((s) => (
                  <Command.Item key={s.id} onSelect={() => run(() => scrollTo(s.id))} className={ITEM_CLS}>
                    {s.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
