"use client";

import { useWorkspace } from "@/lib/store";
import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { Kbd } from "@verit/proof-ui";

const SUGGESTIONS = [
  "Focus on security-relevant changes",
  "Focus on protocol compatibility",
  "Show highest-risk areas only",
  "Reset the view",
];

export function CommandBar() {
  const { sendCommand, commandBusy, answers, live } = useWorkspace();
  const [value, setValue] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !/input|textarea/i.test((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const last = answers[answers.length - 1];

  const submit = () => {
    if (!value.trim() || commandBusy) return;
    sendCommand(value);
    setValue("");
    setLogOpen(true);
  };

  return (
    <div className="border-t border-line bg-surface">
      {logOpen && answers.length > 0 && (
        <div className="max-h-[30vh] overflow-y-auto scroller border-b border-line px-4 py-2">
          {answers.slice(-6).map((a, i) => (
            <div key={i} className="py-1.5">
              {a.command && (
                <div className="font-mono text-[11px] text-ink-3">▸ {a.command}</div>
              )}
              <div className="mt-0.5 text-[12px] leading-snug text-ink-2">
                {a.pending ? (
                  <span className="inline-flex items-center gap-2 text-ink-3">
                    <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />
                    analyzing…
                  </span>
                ) : (
                  a.text
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-2">
        <span
          className={clsx(
            "size-[7px] shrink-0 rounded-full",
            commandBusy ? "bg-warn" : "bg-accent",
          )}
        />
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            live
              ? 'Ask the workspace: "why is CI failing?", "focus on security"'
              : 'Command the workspace: try "focus on protocol compatibility"'
          }
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-ink-3"
          disabled={commandBusy}
        />
        </form>
        {answers.length > 0 && (
          <button
            onClick={() => setLogOpen((v) => !v)}
            className="tnum rounded-[4px] px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-surface-2"
          >
            {logOpen ? "hide" : `${answers.length} answers`}
          </button>
        )}
        <Kbd>/</Kbd>
      </div>
      {!last && (
        <div className="flex gap-1.5 px-4 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => sendCommand(s)}
              className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
