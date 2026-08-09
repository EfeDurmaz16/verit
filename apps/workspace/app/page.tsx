"use client";

import { CommandBar } from "@/components/command-bar";
import { ContextPanel } from "@/components/context-panel";
import { registry } from "@/components/registry";
import { Header, Palette, Rail } from "@/components/shell";
import { useWorkspace, WorkspaceProvider } from "@/lib/store";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { clsx } from "clsx";

function MetricsStrip() {
  const { pr } = useWorkspace();
  if (!pr) return null;
  const metrics = [
    { label: "Changed files", value: String(pr.changedFiles) },
    { label: "Diff", value: `+${pr.additions.toLocaleString()} −${pr.deletions.toLocaleString()}` },
    { label: "Commits", value: String(pr.commits) },
    { label: "Threads", value: String(pr.threads) },
    { label: "Author", value: pr.author },
  ];
  return (
    <div className="grid grid-cols-5 divide-x divide-line rounded-lg border border-line bg-surface">
      {metrics.map((m) => (
        <div key={m.label} className="px-3 py-2">
          <div className="tnum truncate text-[17px] font-medium leading-tight">{m.value}</div>
          <div className="text-[11px] text-ink-3">{m.label}</div>
        </div>
      ))}
    </div>
  );
}

function Workspace() {
  const { spec, status } = useWorkspace();
  return (
    <main className="scroller min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-7 px-6 py-5">
        <MetricsStrip />
        {spec?.root && spec.elements[spec.root] ? (
          <Renderer spec={spec} registry={registry} />
        ) : (
          <div className="flex flex-col gap-3 pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-line bg-surface p-3">
                <div className="skeleton mb-2 h-3 w-1/4" />
                <div className="skeleton mb-2 h-3 w-3/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            ))}
            <p className={clsx("text-center text-[12px] text-ink-3", status === "error" && "text-danger")}>
              {status === "fetching"
                ? "Fetching pull request from GitHub…"
                : status === "error"
                  ? "Analysis failed — check the header for details."
                  : "Assembling workspace…"}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

export default function Page() {
  return (
    <WorkspaceProvider>
      <JSONUIProvider registry={registry}>
          <div className="flex h-full flex-col">
            <Header />
            <div className="flex min-h-0 flex-1">
              <Rail />
              <Workspace />
              <aside className="w-[320px] shrink-0 border-l border-line bg-surface">
                <ContextPanel />
              </aside>
            </div>
            <CommandBar />
          </div>
          <Palette />
      </JSONUIProvider>
    </WorkspaceProvider>
  );
}
