"use client";

import { CommandBar } from "@/components/command-bar";
import { ContextPanel } from "@/components/context-panel";
import { Header, Palette, Rail } from "@/components/shell";
import { useWorkspace, WorkspaceProvider } from "@/lib/store";
import { ProofUiProvider, registry, type ProofUiHost } from "@verit/proof-ui";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { useMemo, type ReactNode } from "react";

/** The live store, in the shape the shared proof registry reads. */
function ProofUiBridge({ children }: { children: ReactNode }) {
  const { status, selection, highlight, focus, proveBusy, select, flashFiles, prove } =
    useWorkspace();
  const host = useMemo<ProofUiHost>(
    () => ({ status, selection, highlight, focus, proveBusy, select, flashFiles, prove }),
    [status, selection, highlight, focus, proveBusy, select, flashFiles, prove],
  );
  return <ProofUiProvider host={host}>{children}</ProofUiProvider>;
}

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
  const { spec, status, error } = useWorkspace();
  const hasSpec = Boolean(spec?.root && spec.elements[spec.root]);
  return (
    <main className="scroller min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-7 px-6 py-5">
        <MetricsStrip />
        {hasSpec ? (
          <Renderer spec={spec!} registry={registry} />
        ) : status === "idle" ? (
          <div className="flex flex-col items-center gap-1.5 pt-20 text-center">
            <p className="text-[13px] font-medium text-ink-2">No pull request loaded</p>
            <p className="text-[12px] text-ink-3">
              Paste a GitHub PR URL in the header to start analysis.
            </p>
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-center gap-2 pt-20 text-center">
            <p className="text-[13px] font-medium text-danger">Analysis could not finish</p>
            <p className="max-w-[440px] text-[12px] text-ink-2">
              {error ?? "The pull request could not be loaded."}
            </p>
            <p className="text-[12px] text-ink-3">
              Check the pull request URL in the header, then run it again.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-2" aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading the review…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-line bg-surface p-3">
                <div className="skeleton mb-2 h-3 w-1/4" />
                <div className="skeleton mb-2 h-3 w-3/4" />
                <div className="skeleton h-3 w-1/2" />
              </div>
            ))}
            <p className="text-center text-[12px] text-ink-3">
              {status === "fetching"
                ? "Fetching pull request from GitHub…"
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
      <ProofUiBridge>
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
      </ProofUiBridge>
    </WorkspaceProvider>
  );
}
