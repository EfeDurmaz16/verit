"use client";

import { useEffect } from "react";

/* Segment error boundary for every dashboard page below the root layout. A run
   list or proof page whose data call fails lands here, not on a raw stack. The
   real error is logged server-side under error.digest; we show a plain sentence
   and a way back. */
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
    <div className="mx-auto max-w-[460px] pt-16 text-center">
      <h1 className="text-[15px] font-medium">This page did not load</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">
        Something failed while loading it. This is usually temporary. Try again,
        or reload the page.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-[11px] text-ink-3">ref {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="mt-5 inline-block rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium transition-colors hover:border-accent hover:text-accent-text"
      >
        Try again
      </button>
    </div>
  );
}
