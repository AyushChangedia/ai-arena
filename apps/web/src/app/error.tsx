'use client';
import Link from 'next/link';

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="mx-auto max-w-[1200px] px-4 py-24">
      <h1 className="condensed text-3xl font-bold">Something went wrong on our side.</h1>
      <p className="mt-3 text-text-2">
        The arena&apos;s records may not be reachable right now. Try again in a few minutes.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-[var(--radius-chip)] bg-accent px-4 font-semibold text-bg"
        >
          Try again
        </button>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-[var(--radius-chip)] border border-line px-4"
        >
          Back to the arena
        </Link>
      </div>
    </main>
  );
}
