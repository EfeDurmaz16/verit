/* Suspense fallback for one proof page. Shaped like the real run page:
   breadcrumb, title, meta row, then the proof sections, so the layout does not
   jump when the run resolves. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the proof page…</span>
      <div>
        <div className="skeleton h-3 w-40" />
        <div className="skeleton mt-2 h-5 w-3/4 max-w-[420px]" />
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="skeleton h-4 w-24" />
          <div className="skeleton h-4 w-32" />
          <div className="skeleton h-4 w-20" />
        </div>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-line bg-surface p-3">
          <div className="skeleton mb-3 h-2.5 w-24" />
          <div className="skeleton mb-2 h-3 w-3/4" />
          <div className="skeleton h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
