import Link from "next/link";

/* Human 404 for a repo or run that does not exist, or that this GitHub account
   cannot read. requireRepoAccess and getRun both route here through
   notFound(); a missing private repo reads the same as one that is not there,
   on purpose. */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-[460px] pt-16 text-center">
      <h1 className="text-[15px] font-medium">Not found</h1>
      <p className="mt-1.5 text-[13px] text-ink-2">
        This repo or run does not exist, or your GitHub account cannot read it.
        Verit only shows what you can already see on GitHub.
      </p>
      <Link
        href="/"
        className="mt-5 inline-block rounded-md border border-line-strong px-3 py-1.5 text-[13px] font-medium transition-colors hover:border-accent hover:text-accent-text"
      >
        Back to your runs
      </Link>
    </div>
  );
}
