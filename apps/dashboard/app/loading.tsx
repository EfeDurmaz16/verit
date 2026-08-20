/* Suspense fallback for the run-history pages. Shown while a dynamic page
   fetches its rows, so navigation never lands on a blank frame. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton h-5 w-40" />
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2.5">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton ml-auto h-4 w-16" />
          </li>
        ))}
      </ul>
    </div>
  );
}
