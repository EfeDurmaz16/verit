"use client";

import { useEffect } from "react";

/* Render-crash boundary for the workspace shell. Data and stream failures are
   handled in the store (they set an error and keep the shell up); this only
   catches an uncaught render error, so the whole surface never goes blank. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="max-w-[420px] text-center">
        <h1 className="text-[15px] font-medium">The workspace stopped rendering</h1>
        <p className="mt-1.5 text-[13px] text-ink-2">
          Something in the review view crashed. Your run is not lost. Reset the
          view, or reload the page to reattach to the session.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-[11px] text-ink-3">ref {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="mt-5 inline-block rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium transition-colors hover:border-accent hover:text-accent-text"
        >
          Reset the view
        </button>
      </div>
    </div>
  );
}
